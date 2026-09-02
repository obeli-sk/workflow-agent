// obelisk-agent:workflow-js/workflow.run-cancellable
//   func(prompt: string, model: option<string>, descriptor-ffqn: option<string>,
//        effort: option<string>, name: option<string>) -> result<_, string>
//
// PORT (Phase 1 subset): workflow/workflow-rs/src/{agent,session}.rs. One
// persistent Bash instance, a "session-events" notification join set (the
// workflow self-stubs each event so it lands as a durably readable response),
// and a "user" join set racing each LLM completion against an always-
// outstanding user-injection offer. See docs/js-backend-migration.md for what
// this phase intentionally leaves out (programs/MCP/mounts/chat/rename/
// ask-user/per-script watch — session.rs's fuller feature set) and why.
//
// WIT record/variant field and case names cross into JS as snake_case (not
// camelCase — only function/interface names get kebab-to-camelCase); this was
// confirmed against activity/config-discover.js, an already-deployed activity
// returning `max_steps`/`mcp_servers`/`webhook_url` for the kebab-case WIT
// record `{max-steps, mcp-servers, webhook-url}`. Pure helpers (no `obelisk`
// global, no WIT imports) live in session-logic.js so they can be unit
// tested; this file is the host-facing orchestration only.

import { discover } from "obelisk-agent:config/config";
import { completionSubmit } from "obelisk-agent:llm-obelisk-ext/chat";
import { injectionSubmit, recordOutputSubmit } from "obelisk-agent:stub-obelisk-ext/stub";
import { recordOutputStub } from "obelisk-agent:stub-obelisk-stub/stub";
import { Bash } from "../../../vendor/just-bash/src/bash.js";
import * as obeliskPack from "../../../vendor/just-bash/src/obelisk-pack.js";
import * as obeliskProgram from "../../../vendor/just-bash/src/obelisk-program.js";
import * as obeliskMcp from "../../../vendor/just-bash/src/obelisk-mcp.js";
import * as obeliskWeb from "../../../vendor/just-bash/src/obelisk-web.js";
import { createHost } from "./host.js";
import {
    BASH_TOOLS_JSON,
    EMPTY_REPLY_NUDGE,
    appendShellExchange,
    containsBackgroundStatement,
    elapsedMilliseconds,
    emptyReplyError,
    hasUserVisibleText,
    interruptedError,
    llmErrorEvent,
    openingShellScript,
    renderMount,
    renderSystemPrompt,
    shellResultOf,
    shortWarningId,
    stepLimitError,
    stepWarningText,
    stepWarningThreshold,
    toolError,
    toolOk,
    toolResultMessageValue,
    userText,
} from "./session-logic.js";

// obelisk-agent:mounts/components.request: the read-only reference tree of
// example components (obeli-sk/components), mounted at /workspace/components
// (see obelisk-pack.js's SYSTEM_PROMPT). Fixed FFQN, not operator-configured.
const COMPONENTS_MOUNT_FFQN = "obelisk-agent:mounts/components.request";

const DEFAULT_DESCRIPTOR_FFQN = "obelisk-control:agent/pack.describe";
const SESSION_EVENTS_JOIN_SET = "session-events";

export default function runCancellable(prompt, model, descriptorFfqn, effort, name) {
    try {
        return runInner(prompt ?? "", model ?? "", descriptorFfqn ?? "", effort ?? "", name ?? "");
    } catch (e) {
        throw errorMessage(e);
    }
}

function runInner(prompt, model, descriptorFfqn, effort, name) {
    const descriptor = descriptorFfqn || DEFAULT_DESCRIPTOR_FFQN;
    const described = obelisk.call(descriptor, []);
    if (typeof described?.prompt !== "string") {
        throw `descriptor ${descriptor} did not return { prompt }`;
    }
    const warnings = Array.isArray(described.warnings)
        ? described.warnings.filter((w) => typeof w === "string" && w.trim())
        : [];
    agentLoop(prompt, described.prompt, model, effort, warnings, name);
}

function errorMessage(e) {
    if (e instanceof obelisk.ChildError) {
        return typeof e.value === "string" ? e.value : (e.message ?? "child execution failed");
    }
    if (typeof e === "string") return e;
    return e?.message ?? String(e);
}

// ----- notifications: self-stub each session event onto a durable join set -----

class Notifications {
    constructor() {
        this.joinSet = obelisk.createJoinSet({ name: SESSION_EVENTS_JOIN_SET });
        this.turnIndex = 0;
    }

    setTurnIndex(turnIndex) {
        this.turnIndex = turnIndex;
    }

    notify(event) {
        const execId = recordOutputSubmit(this.joinSet);
        recordOutputStub(execId, { ok: event });
        this.joinSet.joinNext();
        if (this.joinSet.lastId !== execId) {
            throw `unexpected session event response: ${this.joinSet.lastId}`;
        }
    }
}

function hostNowMs() {
    return Date.now();
}

function hostSleepMs(ms) {
    if (ms <= 0) return;
    try {
        obelisk.sleep({ milliseconds: ms });
    } catch {
        // Cancelled durable sleep: the `sleep` builtin just returns, matching
        // session.rs's host_sleep_ms (which drops the cancellation error too).
    }
}

function loadSessionConfig() {
    const config = discover();
    return {
        maxSteps: config.max_steps,
        programs: config.programs ?? [],
        mcpServers: config.mcp_servers ?? [],
        webhookUrl: config.webhook_url ?? "",
    };
}

// ----- programs / MCP servers / mounts (PORT: session.rs's agent_loop setup) -----

// Registers one shell command per operator-configured program
// (PROGRAMS_JSON), plus the `mcp` registry command and one command per
// configured MCP server (MCP_SERVERS_JSON) and the `mount` listing command.
// Each handler owns its own host (matching session.rs's `host()` closure
// pattern: one RealHost-equivalent per registration, not shared mutable
// state) since `createHost()` is stateless and cheap.
function registerProgramsAndMcp(bash, config) {
    for (const program of config.programs) {
        bash.registerCommand(program.name, obeliskProgram.commandHandler(program.name, program.ffqn, createHost()));
    }

    const mcpRegistry = config.mcpServers.map(({ name, ffqn }) => ({ name, ffqn }));
    bash.registerCommand("mcp", obeliskMcp.registryCommandHandler(mcpRegistry, createHost()));
    for (const { name, ffqn } of config.mcpServers) {
        bash.registerCommand(name, obeliskMcp.serverCommandHandler(name, ffqn, createHost()));
    }

    bash.registerCommand("mount", mountCommandHandler(config.mcpServers, config.webhookUrl));
}

// The `mount` shell command: list the session's network-backed mount points
// and live-probe each MCP server's reachability (PORT: session.rs's
// `mount_command`/`render_mount`).
function mountCommandHandler(mcpServers, webhookUrl) {
    return (_interp, _args, _stdin) => {
        const host = createHost();
        const probe = (ffqn) => {
            try {
                host.callJson(ffqn, '["tools/list","{}"]');
                return null;
            } catch (e) {
                return typeof e === "string" ? e : String(e?.message ?? e);
            }
        };
        return { stdout: renderMount(mcpServers, webhookUrl, probe), stderr: "", exitCode: 0 };
    };
}

// Registers the deployment tree, the read-only components reference tree, and
// each MCP server's resources as lazy VFS mounts (PORT: session.rs's
// pack_mounted block). None of this makes a host call by itself - a
// bash-only session that never references a mounted path never touches the
// network - so it is safe to run unconditionally, once, right after the
// input offer opens.
function mountPacks(bash, config) {
    const fs = bash.fs();
    fs.setBlobLoader(obeliskPack.blobLoader(createHost()));
    obeliskPack.registerDeferredMount(fs, createHost());
    obeliskWeb.mount(fs, createHost(), COMPONENTS_MOUNT_FFQN, "/workspace/components");
    for (const { name, ffqn } of config.mcpServers) {
        obeliskMcp.registerDeferredMount(fs, createHost(), createHost(), ffqn, `/workspace/mcp/${name}`);
    }
}

// ----- shell exec -----

function execShell(bash, script, stdin) {
    if (containsBackgroundStatement(script)) {
        const message = "bash: background jobs with `&` are not supported in durable sessions\n";
        return { output: [{ fd: "stderr", text: message }], exitCode: 2, interrupted: null };
    }
    return bash.exec(script, { stdin });
}

// ----- session input application -----

function applySessionInput(event, turnIndex, shellCompletesTurn, notifications, bash, messages) {
    if (event.shell) {
        const { id, script, stdin = "" } = event.shell;
        const startedAt = hostNowMs();
        const result = execShell(bash, script, stdin);
        const durationMilliseconds = elapsedMilliseconds(startedAt, hostNowMs());
        const record = {
            id, script, result: shellResultOf(result), turn_index: turnIndex,
            duration_milliseconds: durationMilliseconds, turn_complete: shellCompletesTurn,
        };
        notifications.notify({ shell_output: record });
        appendShellExchange(messages, record, stdin);
        return false;
    }
    if (event.prompt) {
        const { id, text } = event.prompt;
        notifications.notify({ user_message: { id, text, turn_index: turnIndex } });
        messages.push(userText(text));
        return true;
    }
    // interrupt: nothing is iterating while idle, so this is a stale click.
    return false;
}

// ----- durable "user" channel: LLM completion raced against injection -----

function openSession(turnIndex, notifications) {
    const joinSet = obelisk.createJoinSet({ name: "user" });
    const injectionId = injectionSubmit(joinSet);
    notifications.notify({ input_offered: { execution_id: injectionId, turn_index: turnIndex } });
    return { joinSet, injectionId, turnIndex };
}

function rearmUserInput(session, notifications) {
    session.injectionId = injectionSubmit(session.joinSet);
    notifications.notify({ input_offered: { execution_id: session.injectionId, turn_index: session.turnIndex } });
}

function publishAgentStatus(notifications, working, turnIndex) {
    notifications.notify({ agent_status: { working, turn_index: turnIndex } });
}

function takeUserEvent(session, notifications) {
    let event;
    try {
        event = session.joinSet.joinNext();
    } catch (e) {
        throw `session injection failed: ${errorMessage(e)}`;
    }
    if (session.joinSet.lastId !== session.injectionId) {
        throw `unexpected session response while idle: ${session.joinSet.lastId}`;
    }
    rearmUserInput(session, notifications);
    return event;
}

// One LLM call raced against the user input offer; each injected event lands
// after the request snapshot, so it reaches the model on the following turn.
function callLlmWithUser(session, system, messages, model, effort, bash, notifications) {
    let promptQueued = false;
    while (true) {
        const requestMessageCount = messages.length;
        const messagesJson = JSON.stringify(messages);
        const startedAt = hostNowMs();
        const completionId = completionSubmit(session.joinSet, system, messagesJson, BASH_TOOLS_JSON, model, effort);

        let interrupted = false;
        let completion;
        while (true) {
            let value;
            let failed = null;
            try {
                value = session.joinSet.joinNext();
            } catch (e) {
                if (!(e instanceof obelisk.ChildError)) throw e;
                failed = e;
            }
            const completedId = session.joinSet.lastId;
            if (completedId === completionId) {
                if (interrupted) { completion = null; break; }
                if (failed) return { kind: "failed", message: `llm.completion failed: ${errorMessage(failed)}` };
                completion = value;
                break;
            } else if (completedId === session.injectionId) {
                if (failed) throw `session injection failed: ${errorMessage(failed)}`;
                const event = value;
                rearmUserInput(session, notifications);
                if (event.interrupt) {
                    interrupted = true;
                } else {
                    promptQueued = promptQueued || applySessionInput(event, session.turnIndex, false, notifications, bash, messages);
                }
            } else {
                throw `unexpected session response: ${completedId}`;
            }
        }

        if (completion === null) return { kind: "interrupted" };
        if (completion.rate_limited) {
            const seconds = Math.max(1, completion.rate_limited.retry_after_seconds);
            try { obelisk.sleep({ seconds }); } catch { /* cancelled: retry immediately */ }
            continue;
        }
        const reply = completion.reply;
        let content;
        try {
            content = JSON.parse(reply.content_json);
        } catch (e) {
            throw `llm reply content_json is not valid JSON: ${e}`;
        }
        if (!Array.isArray(content)) throw "llm reply content must be a JSON array of blocks";
        return {
            kind: "reply",
            content,
            contentJson: reply.content_json,
            durationMilliseconds: elapsedMilliseconds(startedAt, hostNowMs()),
            requestMessageCount,
            promptQueued,
        };
    }
}

// ----- bash tool dispatch -----

function dispatchBash(call, bash) {
    if (call.name !== "bash") return toolError(call.id, `unknown tool: ${call.name}`);
    const script = typeof call.input?.script === "string" ? call.input.script : "";
    if (!script.trim()) return toolError(call.id, "script is required");
    const stdin = typeof call.input?.stdin === "string" ? call.input.stdin : "";
    return toolOk(call.id, shellResultOf(execShell(bash, script, stdin)));
}

// ----- main loop -----

function agentLoop(prompt, systemPrompt, model, effort, descriptorWarnings, name) {
    if (!systemPrompt) throw "system prompt is required";

    const notifications = new Notifications();
    const bash = new Bash({ cwd: "/workspace", nowMs: hostNowMs, sleepMs: hostSleepMs });
    // Always registered, independent of operator config (mirrors session.rs
    // registering obelisk_pack unconditionally right after Bash::new).
    bash.registerCommand("obelisk", obeliskPack.commandHandler(createHost()));

    const config = loadSessionConfig();
    const maxSteps = config.maxSteps;
    registerProgramsAndMcp(bash, config);

    const system = renderSystemPrompt(systemPrompt, config.programs);

    let pendingShell = openingShellScript(prompt);
    let messages = pendingShell === null && prompt.trim() ? [userText(prompt.trim())] : [];

    notifications.notify({
        session_started: { protocol_version: 9, prompt, backend: model, effort, system_prompt: system },
    });

    for (const warning of descriptorWarnings) {
        notifications.notify({ agent_error: { id: `descriptor-warning-${shortWarningId(warning)}`, text: warning, turn_index: 0 } });
    }

    let turnIndex = 0;
    let emptyReplyNudgedTurn = -1;
    let stepWarnedTurn = -1;
    let shouldCallLlm = messages.length > 0;
    let agentSteps = 0;
    const session = openSession(turnIndex, notifications);
    // Deployment/components/MCP-resource trees mount lazily: registering them
    // makes no host call itself, so this runs once the input offer is already
    // open (a live session is visible immediately) without delaying startup.
    mountPacks(bash, config);
    publishAgentStatus(notifications, shouldCallLlm, turnIndex);

    while (true) {
        session.turnIndex = turnIndex;
        notifications.setTurnIndex(turnIndex);
        if (shouldCallLlm && agentSteps >= maxSteps) {
            const error = stepLimitError(turnIndex, maxSteps);
            messages.push({ role: "assistant", content: [{ type: "text", text: error.text }] });
            notifications.notify({ agent_error: error });
            shouldCallLlm = false;
            publishAgentStatus(notifications, false, turnIndex);
            agentSteps = 0;
            turnIndex += 1;
            continue;
        }
        if (shouldCallLlm && agentSteps >= stepWarningThreshold(maxSteps) && stepWarnedTurn !== turnIndex) {
            stepWarnedTurn = turnIndex;
            messages.push(userText(stepWarningText(maxSteps)));
        }

        let turnComplete = false;
        if (!shouldCallLlm) {
            const event = pendingShell !== null
                ? { shell: { id: `shell-opened-${turnIndex}`, script: pendingShell, stdin: "" } }
                : takeUserEvent(session, notifications);
            pendingShell = null;
            shouldCallLlm = applySessionInput(event, turnIndex, true, notifications, bash, messages);
            if (shouldCallLlm) publishAgentStatus(notifications, true, turnIndex);
            turnComplete = !shouldCallLlm;
        } else {
            publishAgentStatus(notifications, true, turnIndex);
            const outcome = callLlmWithUser(session, system, messages, model, effort, bash, notifications);
            if (outcome.kind === "failed") {
                notifications.notify({ agent_error: llmErrorEvent(turnIndex, outcome.message) });
                shouldCallLlm = false;
                agentSteps = 0;
                publishAgentStatus(notifications, false, turnIndex);
                turnIndex += 1;
                continue;
            }
            if (outcome.kind === "interrupted") {
                const error = interruptedError(turnIndex);
                messages.push({ role: "assistant", content: [{ type: "text", text: error.text }] });
                notifications.notify({ agent_error: error });
                shouldCallLlm = false;
                agentSteps = 0;
                publishAgentStatus(notifications, false, turnIndex);
                turnIndex += 1;
                continue;
            }

            agentSteps += 1;
            const calls = outcome.content
                .filter((b) => b?.type === "tool_use")
                .map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} }));
            const nudgeEmptyReply = calls.length === 0 && !outcome.promptQueued && !hasUserVisibleText(outcome.content) && emptyReplyNudgedTurn !== turnIndex;
            const assistantCompletesTurn = calls.length === 0 && !outcome.promptQueued && !nudgeEmptyReply;
            notifications.notify({
                assistant_reply: {
                    content_json: outcome.contentJson,
                    turn_index: turnIndex,
                    duration_milliseconds: outcome.durationMilliseconds,
                    turn_complete: assistantCompletesTurn,
                },
            });
            messages.splice(outcome.requestMessageCount, 0, { role: "assistant", content: outcome.content });

            if (calls.length > 0) {
                const resultBlocks = [];
                for (const call of calls) {
                    const startedAt = hostNowMs();
                    const block = dispatchBash(call, bash);
                    const durationMilliseconds = elapsedMilliseconds(startedAt, hostNowMs());
                    notifications.notify({
                        tool_result: {
                            id: call.id,
                            output: block.ok ? { ok: block.result } : { error: block.message },
                            turn_index: turnIndex,
                            duration_milliseconds: durationMilliseconds,
                        },
                    });
                    resultBlocks.push(toolResultMessageValue(block));
                }
                messages.splice(outcome.requestMessageCount + 1, 0, { role: "user", content: resultBlocks });
                shouldCallLlm = true;
            } else if (nudgeEmptyReply) {
                emptyReplyNudgedTurn = turnIndex;
                messages.splice(outcome.requestMessageCount + 1, 0, userText(EMPTY_REPLY_NUDGE));
                shouldCallLlm = true;
            } else {
                if (!outcome.promptQueued && !hasUserVisibleText(outcome.content)) {
                    notifications.notify({ agent_error: emptyReplyError(turnIndex) });
                }
                shouldCallLlm = outcome.promptQueued;
                agentSteps = 0;
                turnComplete = assistantCompletesTurn;
                if (!shouldCallLlm) publishAgentStatus(notifications, false, turnIndex);
            }
        }
        if (turnComplete) turnIndex += 1;
    }
}
