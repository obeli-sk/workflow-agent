import "./boa-polyfills.js";
import { Bash } from "../../../just-bash/packages/just-bash/src/EmbeddedBash.ts";
import {
    createLazyCommands,
    getCommandNames,
} from "../../../just-bash/packages/just-bash/src/commands/registry.ts";
import { parse } from "../../../just-bash/packages/just-bash/src/parser/parser.ts";
import {
    commands as obeliskCommands,
    descriptor as obeliskPack,
    mount as mountObeliskPack,
} from "../packs/obelisk-control/workflow-pack.js";

const MAX_TURNS = 30;
const MAX_TOOL_RESULT_BYTES = 96 * 1024;
const INJECTION_FFQN = 'obelisk-agent:agent/session.injection';
const OUTPUT_FFQN = 'obelisk-agent:agent/session.record-output';
const COMPLETION_FFQN = 'obelisk-agent:llm/chat.completion';
const BASH_TOOLS_JSON = JSON.stringify([{
    name: 'bash',
    description: 'Run a Bash script in the session persistent virtual workspace.',
    input_schema: {
        type: 'object',
        properties: {
            script: { type: 'string' },
            stdin: { type: 'string' },
        },
        required: ['script'],
    },
}]);
// Keep the workflow core aligned with just-bash's browser command catalog.
// Host I/O and non-browser runtimes remain pack concerns.
const WORKFLOW_UNAVAILABLE_COMMANDS = new Set(['gzip', 'gunzip', 'zcat']);
const CORE_COMMANDS = createLazyCommands(
    getCommandNames().filter((name) => !WORKFLOW_UNAVAILABLE_COMMANDS.has(name)),
);

// The session loop owns provider-neutral message history, one persistent Bash
// instance, and one operator input channel per turn. `toolsJson` is retained in
// the WIT signature for deployment compatibility but intentionally ignored: Bash
// is the only model-facing tool, and compiled packs contribute shell commands.
export default async function agentLoop(prompt, systemPrompt, _toolsJson, model, effort) {
    if (typeof prompt !== 'string') throw 'prompt must be a string';
    if (typeof systemPrompt !== 'string' || !systemPrompt) throw 'system prompt is required';

    const bash = new Bash({
        cwd: '/workspace',
        bundledCommands: CORE_COMMANDS,
        customCommands: obeliskCommands(),
        defenseInDepth: false,
        executionLimits: {
            maxExecutionTimeMs: Number.POSITIVE_INFINITY,
            maxFileSystemBytes: 32 * 1024 * 1024,
            maxOutputSize: 1024 * 1024,
            maxSourceBytes: 1024 * 1024,
        },
        now: () => 0,
        sleep: async (milliseconds) => {
            if (milliseconds > 0) {
                obelisk.sleep({ milliseconds });
            }
        },
    });
    const shell = { bash, cwd: '/workspace' };
    const system = `${systemPrompt}

# Shell

The only model-facing tool is bash. Its filesystem persists for this session.
${obeliskPack.systemPrompt}`;
    const messages = prompt.trim() ? [userText(prompt.trim())] : [];
    // Shell outputs are stubbed and drained synchronously, so one named set
    // serves the whole session; each turn opens its own operator set below.
    const outputJoinSet = obelisk.createJoinSet({ name: 'record-output' });
    let packMounted = false;
    let turnIndex = 0;
    let pendingPrompt = messages.length > 0;
    try {
        while (true) {
            // A turn is one operator round: open a fresh named operator set,
            // wait for the prompt that starts it, run the model until it yields
            // a plain response, then close the set. The name embeds the turn
            // index because a named set's name is reserved for the execution's
            // whole history and cannot be reused across turns.
            const session = openTurn(turnIndex, outputJoinSet);
            try {
                if (!packMounted) {
                    // Open the input offer (in openTurn) before mounting packs so
                    // the UI can identify a live session immediately.
                    try {
                        await mountObeliskPack(shell.bash.fs);
                    } catch (error) {
                        console.log(`obelisk-control mount unavailable: ${callErrorMessage(error)}`);
                    }
                    packMounted = true;
                }
                if (!pendingPrompt) {
                    // Idle: run operator shell commands inline and keep the offer
                    // open until a prompt arrives to start the model's work.
                    while (!(await applySessionEvent(parseSessionEvent(takeOperatorEvent(session)), session, shell, messages))) {}
                }
                pendingPrompt = false;

                let step = 0;
                while (true) {
                    if (step >= MAX_TURNS) throw `exceeded MAX_TURNS=${MAX_TURNS} without yielding an assistant response`;
                    console.log(`--- turn ${turnIndex} step ${step} ---`);
                    const reply = await callLlmWithOperator(
                        session, system, messages, BASH_TOOLS_JSON, model, effort, shell,
                    );
                    step += 1;
                    messages.splice(reply.requestMessageCount, 0, {
                        role: 'assistant',
                        content: reply.content,
                    });

                    const calls = reply.content
                        .filter((b) => b && b.type === 'tool_use')
                        .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
                    if (calls.length > 0) {
                        console.log(`dispatching ${calls.length} tool call(s)`);
                        const resultBlocks = [];
                        for (const call of calls) {
                            const block = await dispatchBash(call, shell);
                            const status = block.is_error ? `err=${block.content.replace(/^Error:\s*/, '')}` : 'ok';
                            console.log(`  ${call.name}: ${status}`);
                            resultBlocks.push(block);
                        }
                        messages.splice(reply.requestMessageCount + 1, 0, {
                            role: 'user',
                            content: resultBlocks,
                        });
                        continue;
                    }
                    console.log(`assistant response after ${step} step(s); waiting for operator input`);
                    break;
                }
            } finally {
                try { session.joinSet.close(); }
                catch (error) { console.log(`turn ${turnIndex} operator channel close failed: ${String(error)}`); }
            }
            turnIndex += 1;
        }
    } finally {
        try { outputJoinSet.close(); }
        catch (error) { console.log(`session output close failed: ${String(error)}`); }
    }
}

async function dispatchBash(call, shell) {
    if (call.name !== 'bash') return toolError(call.id, `unknown tool: ${call.name}`);
    const script = typeof call.input?.script === 'string' ? call.input.script : '';
    if (!script.trim()) return toolError(call.id, 'script is required');
    try {
        const result = await execShell(
            shell,
            script,
            typeof call.input?.stdin === 'string' ? call.input.stdin : '',
        );
        return toolOk(call.id, JSON.stringify(shellResult(result)));
    } catch (error) {
        return toolError(call.id, String(error));
    }
}

async function applySessionEvent(event, session, shell, messages) {
    if (event.kind === 'shell') {
        const result = await execShell(shell, event.script, event.stdin || '');
        const record = {
            id: event.id,
            script: event.script,
            result: shellResult(result),
        };
        publishShellResult(session, record);
        return false;
    }
    messages.push(userText(event.text));
    return true;
}

function publishShellResult(session, record) {
    const recordJson = JSON.stringify(record);
    const executionId = session.outputJoinSet.submit(OUTPUT_FFQN, [record.id]);
    obelisk.stub(executionId, { ok: recordJson });
    const published = session.outputJoinSet.joinNext();
    if (session.outputJoinSet.lastId !== executionId || published !== recordJson) {
        throw `unexpected shell output response: ${session.outputJoinSet.lastId}`;
    }
}

async function execShell(shell, script, stdin) {
    if (containsBackgroundStatement(script)) {
        return {
            stdout: '',
            stderr: 'bash: background jobs with `&` are not supported in durable sessions\n',
            exitCode: 2,
        };
    }
    const result = await shell.bash.exec(script, {
        stdin,
        cwd: shell.cwd,
    });
    const nextCwd = result?.env?.PWD;
    if (typeof nextCwd === 'string' && nextCwd.startsWith('/')) {
        shell.cwd = nextCwd;
    }
    return result;
}

function containsBackgroundStatement(script) {
    let root;
    try {
        root = parse(script);
    } catch (_) {
        // Let just-bash produce its normal syntax error and exit status.
        return false;
    }
    const pending = [root];
    while (pending.length > 0) {
        const value = pending.pop();
        if (!value || typeof value !== 'object') continue;
        if (value.type === 'Statement' && value.background === true) return true;
        if (Array.isArray(value)) {
            pending.push(...value);
        } else {
            pending.push(...Object.values(value));
        }
    }
    return false;
}

function parseSessionEvent(text) {
    try {
        const event = JSON.parse(text);
        if (event && event.kind === 'shell' && typeof event.script === 'string') {
            return {
                id: typeof event.id === 'string' && event.id ? event.id : String(Math.random()),
                kind: 'shell',
                script: event.script,
                stdin: typeof event.stdin === 'string' ? event.stdin : '',
            };
        }
        if (event && event.kind === 'prompt' && typeof event.text === 'string' && event.text.trim()) {
            return { kind: 'prompt', text: event.text.trim() };
        }
    } catch (_) {}
    return { kind: 'prompt', text: text.trim() };
}

function shellResult(result) {
    return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exit_code: Number(result.exitCode) || 0,
    };
}

// One LLM call raced against the operator input offer. Each shell event runs
// against the same Bash instance and the input offer is re-armed while the LLM
// child remains pending. Prompt events are appended for the next model turn.
async function callLlmWithOperator(session, system, messages, toolsJson, model, effort, shell) {
    while (true) {
        const requestMessageCount = messages.length;
        session.completionExecutionId = session.joinSet.submit(COMPLETION_FFQN, [
            system,
            JSON.stringify(messages),
            toolsJson || '[]',
            model || '',
            effort || '',
        ]);
        console.log(`started completion ${session.completionExecutionId}`);

        let res;
        while (res === undefined) {
            const value = session.joinSet.joinNext();
            const completedId = session.joinSet.lastId;
            if (completedId === session.injectionExecutionId) {
                console.log(`consumed operator injection from ${completedId}`);
                rearmOperator(session);
                const event = parseSessionEvent(value);
                await applySessionEvent(event, session, shell, messages);
                continue;
            }
            if (completedId !== session.completionExecutionId) {
                throw `unexpected session response: ${completedId}`;
            }
            res = value;
            session.completionExecutionId = null;
        }

        if (res && res.rate_limited) {
            const seconds = res.rate_limited.retry_after_seconds > 0 ? res.rate_limited.retry_after_seconds : 1;
            console.log(`rate limited (${res.rate_limited.message}); sleeping ${seconds}s`);
            obelisk.sleep({ seconds });
            continue;
        }
        if (res && res.reply) {
            let content;
            try { content = JSON.parse(res.reply.content_json); }
            catch (e) { throw `llm reply content_json is not valid JSON: ${String(e)}`; }
            if (!Array.isArray(content)) throw 'llm reply content must be a JSON array of blocks';
            return {
                content,
                stop_reason: res.reply.stop_reason,
                requestMessageCount,
            };
        }
        throw `unexpected llm.completion result: ${JSON.stringify(res)}`;
    }
}

// ----- messages ---------------------------------------------------------------

function userText(text) {
    return { role: 'user', content: [{ type: 'text', text }] };
}
function toolOk(id, jsonString) {
    const s = typeof jsonString === 'string' ? jsonString : JSON.stringify(jsonString);
    const encoded = JSON.stringify(s).length;
    if (encoded > MAX_TOOL_RESULT_BYTES) return toolError(id, `result too large (~${encoded} encoded bytes); narrow the request with pagination or a more specific selector`);
    return { type: 'tool_result', tool_use_id: id, content: s, is_error: false };
}
function toolError(id, message) {
    return { type: 'tool_result', tool_use_id: id, content: `Error: ${message}`, is_error: true };
}

// ----- durable session channel ------------------------------------------------
// Each turn owns one named join set holding both the always-outstanding operator
// offer and, while the agent works, its LLM child. This is the durable equivalent
// of a small event loop: whichever child completes first is handled, without
// cloning the VFS. The persistent record-output set is shared across turns.

function openTurn(turnIndex, outputJoinSet) {
    const joinSet = obelisk.createJoinSet({ name: `operator-${turnIndex}` });
    const injectionExecutionId = joinSet.submit(INJECTION_FFQN, []);
    console.log(`opened turn ${turnIndex} operator channel ${injectionExecutionId}`);
    return { joinSet, outputJoinSet, injectionExecutionId, completionExecutionId: null };
}
function rearmOperator(session) {
    session.injectionExecutionId = session.joinSet.submit(INJECTION_FFQN, []);
    console.log(`re-armed operator offer ${session.injectionExecutionId}`);
}
function takeOperatorEvent(session) {
    const text = session.joinSet.joinNext();
    const completedId = session.joinSet.lastId;
    if (completedId !== session.injectionExecutionId) {
        throw `unexpected session response while idle: ${completedId}`;
    }
    if (typeof text !== 'string' || !text.trim()) throw 'injection text must be a non-empty string';
    console.log(`consumed operator injection from ${completedId}`);
    rearmOperator(session);
    return text.trim();
}

function callErrorMessage(e) {
    if (e instanceof obelisk.ChildExecutionError) {
        if (e.value !== undefined) return typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
        return e.message;
    }
    return String(e);
}
