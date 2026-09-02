// obelisk-agent:workflow-js/workflow.run-cancellable
//   func(prompt: string, model: option<string>, descriptor-ffqn: option<string>,
//        effort: option<string>, name: option<string>) -> result<_, string>
//
// PORT: workflow/workflow-rs/src/{agent,session}.rs. One persistent Bash
// instance, a "session-events" notification join set (the workflow self-stubs
// each event so it lands as a durably readable response), and one
// "user-{turn}" join set per conversational turn racing each LLM completion
// against an always-outstanding user-injection offer. Also wires in
// programs/MCP/mounts (obelisk-pack.js/obelisk-program.js/
// obelisk-mcp.js/obelisk-web.js), per-script interrupt/timeout (script-watch.js),
// session rename, ask-user, and chat peer sessions (chat.js) — see
// docs/js-backend-migration.md for phase-by-phase status and fidelity notes.
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
import { askUserSubmit, injectionSubmit, recordOutputSubmit, sessionRenamedSubmit } from "obelisk-agent:stub-obelisk-ext/stub";
import { recordOutputStub, sessionRenamedStub } from "obelisk-agent:stub-obelisk-stub/stub";
import { runCancellableSubmit } from "obelisk-agent:workflow-js-obelisk-ext/workflow";
import { Bash } from "../../../vendor/just-bash/src/bash.js";
import * as obeliskPack from "../../../vendor/just-bash/src/obelisk-pack.js";
import * as obeliskProgram from "../../../vendor/just-bash/src/obelisk-program.js";
import * as obeliskMcp from "../../../vendor/just-bash/src/obelisk-mcp.js";
import * as obeliskWeb from "../../../vendor/just-bash/src/obelisk-web.js";
import { createHost } from "./host.js";
import { arm as armScriptWatch } from "./script-watch.js";
import * as chat from "./chat.js";
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
    parseToolTimeout,
    renderMount,
    renderSystemPrompt,
    validateSlug,
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

// obelisk-agent:mounts/apps.request: one deployed activity backing every
// lazily-mounted GitHub repo tree, mounted at /workspace/apps/<name> per the
// operator-configured APPS_JSON registry (see obelisk-pack.js's
// SYSTEM_PROMPT). Fixed FFQN; which repo each mount browses travels in
// params-json instead.
const APPS_MOUNT_FFQN = "obelisk-agent:mounts/apps.request";

const DEFAULT_DESCRIPTOR_FFQN = "obelisk-control:agent/pack.describe";
const SESSION_EVENTS_JOIN_SET = "session-events";
// Renames publish here instead, so a reader fetches the current name with one
// bounded request instead of racing the mixed session-events stream.
const SESSION_NAME_JOIN_SET = "session-name";
const ASK_USER_FFQN = "obelisk-agent:stub/stub.ask-user";
const NATIVE_CALL_FFQN = "obelisk-control:tools/native.call";
// The operator-configured program whose registration gets wrapped with
// chat.js's caller-aware subcommands (current/rename/create/watch). PORT:
// chat.rs's CHAT_PROGRAM_FFQN.
const CHAT_PROGRAM_FFQN = "obelisk-agent:programs/program.chat";

export default function runCancellable(prompt, model, descriptorFfqn, effort, name) {
    try {
        return runInner(prompt ?? "", model ?? "", descriptorFfqn ?? "", effort ?? "", name ?? "");
    } catch (e) {
        throw errorMessage(e);
    }
}

function runInner(prompt, model, descriptorFfqn, effort, name) {
    if (name) {
        const error = validateSlug(name);
        if (error) throw `invalid session name ${JSON.stringify(name)}: ${error}`;
    }
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
        // Lazily created on first rename: most sessions are never renamed, so
        // this avoids a join set nobody ends up using.
        this.nameJoinSet = null;
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

    humanInputRequested(executionId, question) {
        this.notify({ human_input_requested: { execution_id: executionId, question, turn_index: this.turnIndex } });
    }

    humanInputResolved(executionId) {
        this.notify({ human_input_resolved: { execution_id: executionId, turn_index: this.turnIndex } });
    }

    // PORT: session.rs's Notifications::session_renamed. A dedicated join set
    // (not session-events) so a reader can fetch the current name with one
    // bounded request instead of racing the mixed event stream.
    sessionRenamed(name) {
        if (!this.nameJoinSet) this.nameJoinSet = obelisk.createJoinSet({ name: SESSION_NAME_JOIN_SET });
        const execId = sessionRenamedSubmit(this.nameJoinSet, name);
        sessionRenamedStub(execId, { ok: { name } });
        const published = this.nameJoinSet.joinNext();
        if (this.nameJoinSet.lastId !== execId || published?.name !== name) {
            throw `unexpected session rename response: ${this.nameJoinSet.lastId}`;
        }
    }
}

// PORT: host.rs's RealHost::call_json interception of ASK_USER_FFQN reached
// through native.call, plus RealHost::ask_user itself. Wraps a plain
// createHost() so `obelisk call obelisk-agent:stub/stub.ask-user [...]`
// (the only path that ever reaches native.call, see obelisk-pack.js's
// `targetCall`) is answered by a real join-set-based question/answer
// exchange instead of falling through to native.call's normal HTTP bridge
// to the target instance, which has no such function.
let askUserJoinSetCounter = 0;

function askUserAwareHost(notifications) {
    const host = createHost();
    return {
        callJson(ffqn, paramsJson) {
            if (ffqn === NATIVE_CALL_FFQN) {
                const intercepted = interceptAskUser(paramsJson, notifications);
                if (intercepted !== undefined) return intercepted;
            }
            return host.callJson(ffqn, paramsJson);
        },
    };
}

// `undefined` means "not an ask-user call, fall through to the normal host".
function interceptAskUser(nativeCallParamsJson, notifications) {
    let params;
    try {
        params = JSON.parse(nativeCallParamsJson);
    } catch {
        return undefined;
    }
    if (!Array.isArray(params) || params[0] !== ASK_USER_FFQN) return undefined;
    const targetParamsJson = params[1];
    if (typeof targetParamsJson !== "string") throw "native call requires params-json";
    return askUser(targetParamsJson, notifications);
}

// Returns native.call's own callJson contract: JSON text of native.call's
// decoded (string) return value - i.e. JSON.stringify'd twice, matching how
// a normal callJson(NATIVE_CALL_FFQN, ...) call would encode a string
// result (see host.js's header comment for the "one layer of JSON text"
// convention every obelisk-*.js module is written against).
function askUser(paramsJson, notifications) {
    let params;
    try {
        params = JSON.parse(paramsJson);
    } catch (error) {
        throw `ask-user params_json must be valid JSON: ${error.message}`;
    }
    const question = Array.isArray(params) ? params[0] : undefined;
    if (typeof question !== "string" || !question) throw "ask-user requires a question";

    const joinSet = obelisk.createJoinSet({ name: `ask-user-${askUserJoinSetCounter++}` });
    const executionId = askUserSubmit(joinSet, question);
    notifications.humanInputRequested(executionId, question);
    let answer;
    try {
        answer = joinSet.joinNext();
    } catch (e) {
        throw `ask-user await failed: ${errorMessage(e)}`;
    }
    if (joinSet.lastId !== executionId) throw `unexpected ask-user response: ${joinSet.lastId}`;
    notifications.humanInputResolved(executionId);
    return JSON.stringify(JSON.stringify(answer));
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

function loadSessionConfig(executionId, backend, effort, name) {
    const config = discover(executionId, backend, effort, name);
    return {
        maxSteps: config.max_steps,
        programs: config.programs ?? [],
        mcpServers: config.mcp_servers ?? [],
        apps: config.apps ?? [],
        webhookUrl: config.webhook_url ?? "",
        promptTail: config.prompt_tail,
    };
}

// ----- programs / MCP servers / mounts (PORT: session.rs's agent_loop setup) -----

// Registers one shell command per operator-configured program
// (PROGRAMS_JSON), plus the `mcp` registry command and one command per
// configured MCP server (MCP_SERVERS_JSON) and the `mount` listing command.
// Each handler owns its own host (matching session.rs's `host()` closure
// pattern: one RealHost-equivalent per registration, not shared mutable
// state) since `createHost()` is stateless and cheap. The program whose ffqn
// is CHAT_PROGRAM_FFQN is wrapped so caller-aware subcommands
// (current/rename/create/watch) are answered by this session itself (PORT:
// session.rs's per-program loop).
function registerProgramsAndMcp(bash, config, ownSession, notifications, submitFn) {
    for (const program of config.programs) {
        const plainHandler = obeliskProgram.commandHandler(program.name, program.ffqn, createHost());
        const handler = program.ffqn === CHAT_PROGRAM_FFQN
            ? chat.commandHandler(plainHandler, ownSession, notifications, submitFn)
            : plainHandler;
        bash.registerCommand(program.name, handler);
    }

    const mcpRegistry = config.mcpServers.map(({ name, ffqn }) => ({ name, ffqn }));
    bash.registerCommand("mcp", obeliskMcp.registryCommandHandler(mcpRegistry, createHost()));
    for (const { name, ffqn } of config.mcpServers) {
        bash.registerCommand(name, obeliskMcp.serverCommandHandler(name, ffqn, createHost()));
    }

    bash.registerCommand("mount", mountCommandHandler(config.apps, config.mcpServers, config.webhookUrl));
}

// The `mount` shell command: list the session's network-backed mount points
// and live-probe each MCP server's reachability (PORT: session.rs's
// `mount_command`/`render_mount`).
function mountCommandHandler(apps, mcpServers, webhookUrl) {
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
        return { stdout: renderMount(apps, mcpServers, webhookUrl, probe), stderr: "", exitCode: 0 };
    };
}

// Registers the deployment tree, each APPS_JSON-configured read-only repo
// reference tree, and each MCP server's resources as lazy VFS mounts (PORT:
// session.rs's pack_mounted block). None of this makes a host call by itself -
// a bash-only session that never references a mounted path never touches the
// network - so it is safe to run unconditionally, once, right after the
// input offer opens.
function mountPacks(bash, config) {
    const fs = bash.fs();
    fs.setBlobLoader(obeliskPack.blobLoader(createHost()));
    obeliskPack.registerDeferredMount(fs, createHost());
    for (const { name, owner, repo, ref } of config.apps) {
        obeliskWeb.mount(fs, createHost(), APPS_MOUNT_FFQN, `/workspace/apps/${name}`, { owner, repo, ref });
    }
    for (const { name, ffqn } of config.mcpServers) {
        obeliskMcp.registerDeferredMount(fs, createHost(), createHost(), ffqn, `/workspace/mcp/${name}`);
    }
}

// ----- shell exec -----

// Run one script under its own per-script watch: a fresh join set holding
// the interrupt offer (plus a watchdog when `timeoutMs` is given), announced
// via a `shell-started` event before the script runs so the UI and peer
// sessions (`chat interrupt`, Phase 5) can arm it while the script is still
// going. PORT: session.rs's `exec_shell`, shared by both the direct-shell
// input path and the model tool dispatch (`dispatchBash`) - `timeoutMs` is
// only ever non-null from the latter (a direct-shell turn from the composer
// has no timeout argument to parse).
function execShell(bash, notifications, id, turnIndex, script, stdin, timeoutMs) {
    if (containsBackgroundStatement(script)) {
        const message = "bash: background jobs with `&` are not supported in durable sessions\n";
        return { output: [{ fd: "stderr", text: message }], exitCode: 2, interrupted: null };
    }
    const guard = armScriptWatch(timeoutMs ?? null, id);
    notifications.notify({ shell_started: { id, offer_id: guard.offerExecutionId, turn_index: turnIndex } });
    bash.setScriptWatch(guard.watcher());
    try {
        return bash.exec(script, { stdin });
    } finally {
        bash.setScriptWatch(null);
        guard.close();
    }
}

// ----- session input application -----

function applySessionInput(event, turnIndex, shellCompletesTurn, notifications, bash, messages) {
    if (event.shell) {
        const { id, script, stdin = "" } = event.shell;
        const startedAt = hostNowMs();
        const result = execShell(bash, notifications, id, turnIndex, script, stdin, null);
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
    const joinSet = obelisk.createJoinSet({ name: `user-${turnIndex}` });
    const injectionId = injectionSubmit(joinSet);
    notifications.notify({ input_offered: { execution_id: injectionId, turn_index: turnIndex } });
    return { joinSet, injectionId, turnIndex };
}

function advanceTurn(session, notifications) {
    if (session.joinSet) session.joinSet.close();
    const turnIndex = session.turnIndex + 1;
    session.joinSet = obelisk.createJoinSet({ name: `user-${turnIndex}` });
    session.injectionId = injectionSubmit(session.joinSet);
    session.turnIndex = turnIndex;
    notifications.notify({ input_offered: { execution_id: session.injectionId, turn_index: turnIndex } });
    return turnIndex;
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
                if (failed) return { kind: "failed", message: `llm.completion failed: ${errorMessage(failed)}` };
                completion = value;
                break;
            } else if (completedId === session.injectionId) {
                if (failed) throw `session injection failed: ${errorMessage(failed)}`;
                const event = value;
                if (event.interrupt) {
                    // Closing this turn's join set cancels the outstanding
                    // completion immediately. The outer loop opens the next
                    // turn's uniquely named set after recording the stop.
                    session.joinSet.close();
                    session.joinSet = null;
                    completion = null;
                    break;
                }
                rearmUserInput(session, notifications);
                promptQueued = promptQueued || applySessionInput(event, session.turnIndex, false, notifications, bash, messages);
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

function dispatchBash(call, bash, notifications, turnIndex) {
    if (call.name !== "bash") return toolError(call.id, `unknown tool: ${call.name}`);
    const script = typeof call.input?.script === "string" ? call.input.script : "";
    if (!script.trim()) return toolError(call.id, "script is required");
    const stdin = typeof call.input?.stdin === "string" ? call.input.stdin : "";
    let timeoutMs;
    try {
        timeoutMs = parseToolTimeout(call.input?.timeout);
    } catch (error) {
        return toolError(call.id, typeof error === "string" ? error : String(error));
    }
    const result = execShell(bash, notifications, call.id, turnIndex, script, stdin, timeoutMs);
    return toolOk(call.id, shellResultOf(result));
}

// ----- main loop -----

function agentLoop(prompt, systemPrompt, model, effort, descriptorWarnings, name) {
    if (!systemPrompt) throw "system prompt is required";

    const notifications = new Notifications();
    const bash = new Bash({ cwd: "/workspace", nowMs: hostNowMs, sleepMs: hostSleepMs });
    // Always registered, independent of operator config (mirrors session.rs
    // registering obelisk_pack unconditionally right after Bash::new). Only
    // this registration's host needs the ask-user interception: it's the
    // only path that ever dispatches through native.call (obelisk-pack.js's
    // `targetCall`, backing `obelisk call FFQN`); programs/MCP commands never
    // route through it, so a plain createHost() is enough for those.
    bash.registerCommand("obelisk", obeliskPack.commandHandler(askUserAwareHost(notifications)));

    // A session created with a slug label (`chat create --name`) starts
    // already renamed; anything else arrives unnamed. PORT: session.rs's
    // own_session construction (chat::ChatSelf::new).
    const executionId = obelisk.executionIdCurrent();
    const initialName = name || null;
    const config = loadSessionConfig(executionId, model, effort, initialName);
    const maxSteps = config.maxSteps;
    const ownSession = new chat.ChatSelf(executionId, model, effort, initialName);
    // PORT: chat.rs's create_child's workflow_ext::run_cancellable_submit
    // call, with the descriptor-ffqn positional argument fixed to null
    // (matching Rust's `None`) since a child session always uses the default
    // descriptor.
    const submitFn = (joinSet, childPrompt, childModel, childEffort, childName) =>
        runCancellableSubmit(joinSet, childPrompt, childModel, null, childEffort, childName);
    registerProgramsAndMcp(bash, config, ownSession, notifications, submitFn);

    const system = renderSystemPrompt(systemPrompt, config.programs, config.apps, config.promptTail);

    let pendingShell = openingShellScript(prompt);
    let messages = pendingShell === null && prompt.trim() ? [userText(prompt.trim())] : [];

    notifications.notify({
        session_started: { protocol_version: 9, prompt, backend: model, effort, system_prompt: system },
    });
    // A session created with a slug label (`chat create --name`, Phase 5)
    // starts already renamed; anything else arrives unnamed.
    if (name) notifications.sessionRenamed(name);

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
            turnIndex = advanceTurn(session, notifications);
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
            // A composer/opening shell command runs synchronously right here,
            // with no LLM call to mark the turn "working": publish before it
            // starts (not just after `shouldCallLlm` turns out true) so the
            // composer's Stop control is visible for its whole run, matching
            // a model-driven bash tool call.
            const isShell = Boolean(event.shell);
            if (isShell) publishAgentStatus(notifications, true, turnIndex);
            shouldCallLlm = applySessionInput(event, turnIndex, true, notifications, bash, messages);
            if (shouldCallLlm) publishAgentStatus(notifications, true, turnIndex);
            else if (isShell) publishAgentStatus(notifications, false, turnIndex);
            turnComplete = !shouldCallLlm;
        } else {
            publishAgentStatus(notifications, true, turnIndex);
            const outcome = callLlmWithUser(session, system, messages, model, effort, bash, notifications);
            if (outcome.kind === "failed") {
                notifications.notify({ agent_error: llmErrorEvent(turnIndex, outcome.message) });
                shouldCallLlm = false;
                agentSteps = 0;
                publishAgentStatus(notifications, false, turnIndex);
                turnIndex = advanceTurn(session, notifications);
                continue;
            }
            if (outcome.kind === "interrupted") {
                const error = interruptedError(turnIndex);
                messages.push({ role: "assistant", content: [{ type: "text", text: error.text }] });
                notifications.notify({ agent_error: error });
                shouldCallLlm = false;
                agentSteps = 0;
                publishAgentStatus(notifications, false, turnIndex);
                turnIndex = advanceTurn(session, notifications);
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
                    const block = dispatchBash(call, bash, notifications, turnIndex);
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
        if (turnComplete) turnIndex = advanceTurn(session, notifications);
    }
}
