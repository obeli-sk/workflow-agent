// Pure helpers for session.js: no `obelisk` global, no host-provided WIT
// imports, so this module is importable and testable with plain `node
// --test` (see session-logic.test.js), unlike session.js itself which can
// only be exercised by deploying it.

import { parseScript } from "../../../vendor/just-bash/src/parser.js";
import { SYSTEM_PROMPT as PACK_SYSTEM_PROMPT } from "../../../vendor/just-bash/src/obelisk-pack.js";

export { PACK_SYSTEM_PROMPT };

export const MAX_TOOL_RESULT_BYTES = 96 * 1024;
export const STEP_WARNING_FRACTION = 3;
export const EMPTY_REPLY_NUDGE =
    "Your previous reply had no message content. Reply to the user in Markdown, or call the bash tool to keep working.";

export const BASH_TOOLS_JSON = JSON.stringify([
    {
        name: "bash",
        description:
            "Run a Bash script in the session persistent virtual workspace. Control flow: if/elif/else, for, while, until, case, break, continue. Not supported: [[ ]], function definitions, arrays, background jobs.",
        input_schema: {
            type: "object",
            properties: {
                script: { type: "string" },
                stdin: { type: "string" },
                timeout: {
                    type: "string",
                    description:
                        "Optional wall-clock cap for this script (forms like 30s, 500ms, 5m, 1h30m). When it elapses the script stops at its next command boundary or sleep with exit code 124 and interrupted=\"timeout\".",
                },
            },
            required: ["script"],
        },
    },
]);

// PORT: chat.rs's `parse_duration_ms`. Sleep-style durations: `90s`,
// `500ms`, `5m`, `2h`, composites like `1m30s`; a bare number is seconds.
// Shared between the bash tool's `timeout` argument (Phase 4) and `chat
// send --timeout` (Phase 5). Throws a string message on an invalid form.
export function parseDurationMs(text) {
    const invalid = () => `invalid duration ${JSON.stringify(text)} (use forms like 30s, 500ms, 5m, 1h30m)`;
    if (!text) throw invalid();
    let rest = text;
    let totalMs = 0;
    while (rest.length > 0) {
        const digitsMatch = rest.match(/^[0-9]+/);
        if (!digitsMatch) throw invalid();
        const number = digitsMatch[0];
        rest = rest.slice(number.length);
        const unitMatch = rest.match(/^[A-Za-z]*/);
        const unit = unitMatch[0];
        rest = rest.slice(unit.length);
        const factorMs = { "": 1000, ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
        if (factorMs === undefined) throw invalid();
        totalMs += Number(number) * factorMs;
    }
    return totalMs;
}

// PORT: session.rs's `parse_tool_timeout`. The bash tool's optional
// `timeout`: sleep-style duration text. An absent or blank value means no
// watchdog (`null`). Throws a string message on an invalid form.
export function parseToolTimeout(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw 'timeout must be a string like "5m"';
    if (!value.trim()) return null;
    const ms = parseDurationMs(value);
    if (ms === 0) throw "timeout must be greater than zero";
    return ms;
}

const MAX_SLUG_LEN = 64;

// PORT: chat.rs's `validate_slug` (the shared naming rule for both an
// initial `name` and a later `chat rename`, Phase 5). Kept here rather than
// deferred entirely to Phase 5 since Phase 4's session_renamed already needs
// it for the at-creation name. Returns an error string, or null when valid.
export function validateSlug(name) {
    if (!name || name.length > MAX_SLUG_LEN) return `slug must be 1..=${MAX_SLUG_LEN} characters`;
    if (!/^[a-z0-9-]+$/.test(name)) return "slug allows lowercase letters, digits, and dashes";
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
        return "dashes in a slug must be single and inner";
    }
    return null;
}

// PORT: workflow-rs/src/session.rs's `render_program_help`. `programs` is the
// operator-owned PROGRAMS_JSON registry (see activity/config-discover.js) -
// each `{name, ffqn, description}`.
export function renderProgramHelp(programs) {
    let text =
        "The only model-facing tool is bash. Its filesystem persists for this session. Run `help` to list every command available in the shell. A script can be cut short by an operator or peer interrupt (exit 130) or by its own timeout argument (exit 124); whatever it printed before that stays recorded.";
    if (!programs || programs.length === 0) return `${text}\n`;
    text += " The workflow registers these external commands:\n";
    for (const program of programs) {
        text += program.description
            ? `  ${program.name}  ${program.description}\n`
            : `  ${program.name}\n`;
    }
    return text;
}

// PORT: session.rs's inline "# User input" section (agent_loop's `format!`).
const USER_INPUT_SECTION =
    "# User input\n\n" +
    "When you need a user answer before you can continue the current task, run " +
    "`obelisk call obelisk-agent:stub/stub.ask-user '[\"Your question\"]'`. It publishes the question " +
    "to the UI, blocks, and returns the answer so you can continue in the same turn. Use it only when " +
    "the answer is required to proceed; to end the turn, reply in Markdown without a command.";

export function renderSystemPrompt(systemPrompt, programs) {
    return `${systemPrompt}\n\n# Shell\n\n${renderProgramHelp(programs)}\n${USER_INPUT_SECTION}\n\n${PACK_SYSTEM_PROMPT}\n`;
}

// PORT: workflow-rs/src/session.rs's `MOUNT_HEADER`/`MOUNT_FOOTER`.
const MOUNT_HEADER =
    "Network-backed mounts (lazy: a directory lists and a file's bytes fetch on first access):\n" +
    "  /workspace/deployment/current  target Obelisk active deployment, editable (one request for its whole file index)\n" +
    "  /workspace/components          example components, read-only (obeli-sk/components)\n";
const MOUNT_FOOTER =
    "Avoid tree, find, and recursive grep (grep -r / fgrep -r) across these mounts; use targeted ls and cat.\n";

// PORT: workflow-rs/src/session.rs's `render_mount`. `probe(ffqn)` returns
// `null` when the server responds, or an error message string when it
// doesn't (session.js supplies a real `host.callJson` probe; tests supply a
// fake) - kept a plain function argument rather than a `host` object so this
// stays a pure, host-agnostic renderer like every other helper in this file.
export function renderMount(mcpServers, webhookUrl, probe) {
    let text = MOUNT_HEADER;
    if (webhookUrl) {
        text += `  ${webhookUrl}  target Obelisk webhooks (GET allowed via curl)\n`;
    }
    for (const { name, ffqn } of mcpServers) {
        const error = probe(ffqn);
        const status = error === null ? "responding" : `not responding: ${mountProbeReason(error)}`;
        text += `  /workspace/mcp/${name}  MCP server, read-only (${status})\n`;
    }
    text += MOUNT_FOOTER;
    return text;
}

// PORT: `mount_probe_reason` - a transport failure is often multi-line/verbose;
// reduce it to a short single-line reason for the `mount` listing.
function mountProbeReason(error) {
    return String(error).split("\n")[0].slice(0, 80);
}

export function stepLimitError(turnIndex, maxSteps) {
    return {
        id: `step-limit-${turnIndex}`,
        text: `exceeded MAX_STEPS=${maxSteps} without yielding an assistant response. State for continuation (next user message should say "continue"): the turn ended mid-task; re-derive position from the transcript and the session VFS, then finish or report. Budget resets to ${maxSteps} steps for the next turn.`,
        turn_index: turnIndex,
    };
}

export function stepWarningThreshold(maxSteps) {
    return Math.floor(maxSteps / 4) * STEP_WARNING_FRACTION;
}

export function stepWarningText(maxSteps) {
    return `Step budget warning: you have used about ${stepWarningThreshold(maxSteps)} of ${maxSteps} allowed model invocations this turn. Stop open-ended exploration now. Finish the current task with as few further commands as possible, verify the minimum viable result, and end the turn with a Markdown summary of what was done, what state things are in, and what remains — so the next turn can continue from your report.`;
}

export function llmErrorEvent(turnIndex, message) {
    return { id: `llm-error-${turnIndex}`, text: message, turn_index: turnIndex };
}

export function interruptedError(turnIndex) {
    return {
        id: `interrupted-${turnIndex}`,
        text: 'Turn stopped by user request. State for continuation (next user message should say "continue"): the turn ended mid-task; re-derive position from the transcript and the session VFS, then finish or report.',
        turn_index: turnIndex,
    };
}

export function emptyReplyError(turnIndex) {
    return { id: `empty-reply-${turnIndex}`, text: "model returned an empty response again; ending the turn", turn_index: turnIndex };
}

export function hasUserVisibleText(content) {
    return content.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "");
}

export function userText(text) {
    return { role: "user", content: [{ type: "text", text }] };
}

export function toolOk(id, result) {
    const jsonString = JSON.stringify(result);
    const encodedLen = JSON.stringify(jsonString).length;
    if (encodedLen > MAX_TOOL_RESULT_BYTES) {
        return toolError(id, `result too large (~${encodedLen} encoded bytes); narrow the request with pagination or a more specific selector`);
    }
    return { tool_use_id: id, ok: true, result };
}

export function toolError(id, message) {
    return { tool_use_id: id, ok: false, message };
}

export function toolResultMessageValue(block) {
    if (block.ok) {
        return { type: "tool_result", tool_use_id: block.tool_use_id, content: JSON.stringify(block.result), is_error: false };
    }
    return { type: "tool_result", tool_use_id: block.tool_use_id, content: `Error: ${block.message}`, is_error: true };
}

export function shellResultOf(result) {
    return {
        output: result.output.map((chunk) => (chunk.fd === "stdout" ? { stdout: chunk.text } : { stderr: chunk.text })),
        exit_code: result.exitCode,
        interrupted: result.interrupted ?? null,
    };
}

export function appendShellExchange(messages, record, stdin) {
    const input = { script: record.script };
    if (stdin) input.stdin = stdin;
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: record.id, name: "bash", input }] });
    messages.push({ role: "user", content: [toolResultMessageValue(toolOk(record.id, record.result))] });
}

export function openingShellScript(prompt) {
    if (!prompt.startsWith("$")) return null;
    const script = prompt.slice(1).trim();
    return script ? script : null;
}

// The exact predicate the session loop uses to reject detached jobs (`&`); a
// parse error is not itself a background job, so exec() surfaces the normal
// syntax error instead of this rejection.
export function containsBackgroundStatement(script) {
    try {
        return scriptHasBackground(parseScript(script));
    } catch {
        return false;
    }
}

function scriptHasBackground(script) {
    return script.statements.some(statementHasBackground);
}
function statementHasBackground(statement) {
    return statement.background || statement.pipelines.some((p) => p.commands.some(commandHasBackground));
}
function commandHasBackground(command) {
    if (command.kind !== "compound") return false;
    const c = command.compound;
    switch (c.type) {
        case "if":
            return c.cond.some(statementHasBackground) || c.body.some(statementHasBackground) ||
                c.elifs.some(([cc, b]) => cc.some(statementHasBackground) || b.some(statementHasBackground)) ||
                (c.elseBody ? c.elseBody.some(statementHasBackground) : false);
        case "for": case "cstylefor":
            return c.body.some(statementHasBackground);
        case "while":
            return c.cond.some(statementHasBackground) || c.body.some(statementHasBackground);
        case "case":
            return c.arms.some((a) => a.body.some(statementHasBackground));
        case "group": case "subshell":
            return c.body.some(statementHasBackground);
        default:
            return false;
    }
}

export function elapsedMilliseconds(start, end) {
    return Math.max(0, end - start);
}

export function shortWarningId(warning) {
    return warning.replace(/[^A-Za-z0-9]/g, "").slice(0, 24).toLowerCase();
}
