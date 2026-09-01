// Pure helpers for session.js: no `obelisk` global, no host-provided WIT
// imports, so this module is importable and testable with plain `node
// --test` (see session-logic.test.js), unlike session.js itself which can
// only be exercised by deploying it.

import { parseScript } from "../../../vendor/just-bash/src/parser.js";

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

export function renderSystemPrompt(systemPrompt) {
    return `${systemPrompt}\n\n# Shell\n\nThe only model-facing tool is bash. Its filesystem persists for this session. Run \`help\` to list every command available in the shell. A script can be cut short by an operator or peer interrupt (exit 130) or by its own timeout argument (exit 124); whatever it printed before that stays recorded.\n`;
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
