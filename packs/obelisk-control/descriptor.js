// System-prompt descriptor for the "control this Obelisk instance" use case.
// The generic session loop calls this FFQN once at startup and prepends the
// returned prompt to its shell and user-input guidance.
//
// obelisk-control:agent/pack.describe:
//   func() -> result<record { prompt: string, tools-json: string }, string>
//
// The model's only tool is `bash`. `tools-json` is an unused compatibility
// field from the former model-facing catalog and is always empty.

const nl = String.fromCharCode(10);

// Encoding rules for `obelisk call <ffqn> <params-json>`, the one shell command
// that takes a WIT-typed argument. The rest of the `obelisk` subcommands and
// the deployment edit/submit/apply flow are documented by the shell pack's own
// system prompt, which the core appends after this prompt.
const WIT_JSON_MAPPING = [
    '## Encoding params for `obelisk call`',
    'Run bare `obelisk` to list commands; commands use subcommand pairs such as `obelisk functions list` and `obelisk executions get ID`. Run `obelisk <command> --help` (or `-h`) at any level for usage, e.g. `obelisk deployment submit --help`.',
    'Inspect target signatures with `obelisk functions list` before calling one when the parameter types are not already known.',
    'Call with a JSON array (`obelisk call FFQN \'[1,"text"]\'`) or positional values (`obelisk call FFQN -- 1 text`); positional values parse as JSON when valid and otherwise as strings.',
    'A successful call prints only the target return value; a target `result` err or execution failure exits nonzero and prints the error to stderr.',
    'params-json is a JSON array of positional arguments in WIT parameter order.',
    'WIT kebab-case identifiers become snake_case JSON keys and variant or enum values.',
    'bool maps to JSON true or false.',
    'Integers and floats map to JSON numbers; Obelisk rejects lossy numeric conversions instead of rounding.',
    'char and string map to JSON strings.',
    'option<T> maps to the JSON value for T or null for none.',
    'list<T> maps to a JSON array.',
    'tuple<T1, T2> maps to a JSON array in tuple order.',
    'record { field-name: T } maps to a JSON object such as {"field_name": value}.',
    'variant { case-name(T) } maps to a JSON string for no-payload cases or an object such as {"case_name": value} for payload cases.',
    'enum { case-name } maps to the JSON string "case_name".',
    'flags { flag-name } maps to an array of active flag strings such as ["flag_name"].',
    'result<T, E> maps to {"ok": value} or {"err": value}; result with no payload uses null.',
].join(nl);

const SYSTEM_PROMPT = [
    'You are the planner inside an Obelisk durable workflow that controls a target Obelisk instance, which may be a different instance than the one you run on. The obelisk command and the /workspace/deployment mount act on that target.',
    'Your job is to investigate, plan, and decide which durable actions are needed.',
    'You act entirely through the bash tool: run shell commands, and the `obelisk` command, for durable replayable actions that should appear in the Obelisk execution log; use your own built-in reasoning freely for non-durable investigation within a turn.',
    'Narrate as you work: emit a short Markdown note in the same response as each tool call, saying what you are about to run and why, so the user can follow your reasoning instead of a bare stream of commands. Text and a tool call in one response are both kept, and the turn continues.',
    'A response with no tool call ends the turn and hands control back to the user. Send your final answer, or a non-blocking question, as Markdown with no command attached (use fenced Mermaid blocks only for diagrams). For an answer required before you can continue the current task, use the UI-coordinated ask-user command described in the shell guidance.',
    'Never invent execution IDs, FFQNs, deployment IDs, or command arguments. Discover them first.',
    'If a command returns an error, decide whether to retry, try another command, ask the user, or respond with an explanation.',
    WIT_JSON_MAPPING,
].join(nl + nl);

const DOCS_SECTION = [
    '# Obelisk documentation (rendered llms.txt)',
    'The full documentation index is inlined below. It lists every docs page as a URL; fetch any page with the GET-only curl program, e.g. `curl https://obeli.sk/docs/latest/js/js-workflows/ | sed -n 1,200p` (pages are HTML; strip tags or read selectively). Prefer the JS pages (`/js/js-activities/`, `/js/js-workflows/`, `/js/js-webhooks/`) before writing components.',
    'Never guess workflow host API signatures (`obelisk.call`, `obelisk.sleep`, join sets): they are all documented on the `/js/js-workflows/` page. Read it first.',
].join(nl);

// Docs indexes inlined into the prompt. The deployment manifest passes
// DOCS_URLS_JSON (default: the current llms.txt for this Obelisk version); each
// entry is fetched once here with plain fetch — the descriptor activity carries
// its own outbound-host grant for https://obeli.sk. A failed or oversized
// fetch degrades to a pointer line so session start never breaks.
const MAX_INDEX_BYTES = 64 * 1024;

async function loadDocsIndexes() {
    let urls;
    try { urls = JSON.parse(process.env["DOCS_URLS_JSON"] || "[]"); }
    catch { urls = []; }
    if (!Array.isArray(urls)) urls = [];
    const sections = [];
    for (const url of urls) {
        if (typeof url !== "string" || !url.startsWith("https://")) continue;
        try {
            const resp = await fetch(url);
            const text = await resp.text();
            const body = resp.ok && text.length <= MAX_INDEX_BYTES
                ? text
                : `(index unavailable: HTTP ${resp.status}${text.length > MAX_INDEX_BYTES ? ", too large" : ""})`;
            sections.push(`## ${url}\n\n${body}`);
        } catch (e) {
            sections.push(`## ${url}\n\n(index unavailable: ${String(e)})`);
        }
    }
    return sections.length ? sections.join(nl + nl) : null;
}

export default async function describe() {
    const docs = await loadDocsIndexes();
    const docsBlock = docs ? `${DOCS_SECTION}${nl}${nl}${docs}` : DOCS_SECTION;
    return { prompt: SYSTEM_PROMPT + nl + nl + docsBlock, tools_json: '[]' };
}
