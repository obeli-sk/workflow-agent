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
    'Investigate, plan, and decide which durable actions are needed. Act through bash: shell commands and `obelisk` for durable replayable actions that appear in the Obelisk execution log; built-in reasoning for the rest.',
    'Narrate as you work: emit a short Markdown note alongside each tool call saying what you are about to run and why, so the user can follow your reasoning instead of a bare stream of commands. Text and a tool call in one response are both kept, and the turn continues.',
    'A response with no tool call ends the turn and hands control back to the user: send your final answer, or a non-blocking question, as Markdown with no command attached (fenced Mermaid blocks only for diagrams). For an answer required before you can continue the current task, use the UI-coordinated ask-user command described in the shell guidance.',
    'Never invent execution IDs, FFQNs, deployment IDs, or command arguments; discover them first. If a command errors, retry, try another command, ask the user, or explain — do not guess.',
    'Other agent sessions on this instance are peers you can talk to: discover them with `chat list` (never invent their IDs), inspect with `chat read`/`chat state`, queue messages with `chat send ID text` (delivered when idle, queued while busy), and start new ones with `chat create`. Use peers for parallel or isolated work, not to bypass your own durability.',
    'Authoring JS workflows (obelisk.* host API): read the `/js/js-workflows/` docs page first — its signatures are exact. Prefer static ES-module imports of child functions over `obelisk.call`. In workflow code never invoke a host function speculatively to probe its signature: a malformed durable call traps the whole execution at commit time and cannot be caught in JS. Validate shapes against the docs instead; validation errors from correct-shaped calls ARE catchable.',
    WIT_JSON_MAPPING,
].join(nl);

const DOCS_SECTION = [
    '# Obelisk documentation (rendered llms.txt)',
    'The full documentation index is inlined below; it lists every docs page as a URL. Fetch any page with the GET-only curl program, e.g. `curl https://obeli.sk/docs/latest/js/js-workflows/ | sed -n 1,200p` (pages are HTML; read selectively). Read `/js/js-activities/`, `/js/js-workflows/`, and `/js/js-webhooks/` before writing components; never guess workflow host API signatures (`obelisk.call`, `obelisk.sleep`, join sets) — they are all on `/js/js-workflows/`.',
].join(nl);

// Docs indexes fetched once at session start and inlined into the prompt.
// DOCS_URLS_JSON (deployment.toml; default: the current llms.txt for this
// Obelisk version) lists the indexes; fetching here keeps the doc set pinned
// to the deployed Obelisk without hardcoding anything that could drift. Any
// failed or oversized fetch degrades to a placeholder plus a warning returned
// alongside the prompt, so the session surfaces the degraded-docs state to
// the user instead of failing silently.
const MAX_INDEX_BYTES = 512 * 1024;
const DEGRADE_NOTE = "the model is missing the docs index and may mis-guess API signatures";

async function loadDocsIndexes() {
    let urls;
    try {
        urls = JSON.parse(process.env["DOCS_URLS_JSON"] || "[]");
    } catch {
        return {
            body: null,
            warnings: [`DOCS_URLS_JSON is not valid JSON; ${DEGRADE_NOTE}`],
        };
    }
    if (!Array.isArray(urls)) {
        return {
            body: null,
            warnings: [`DOCS_URLS_JSON is not an array; ${DEGRADE_NOTE}`],
        };
    }
    const sections = [];
    const warnings = [];
    for (const url of urls) {
        if (typeof url !== "string" || !url.startsWith("https://")) continue;
        try {
            const resp = await fetch(url);
            const text = await resp.text();
            if (!resp.ok) {
                warnings.push(`docs index fetch failed (HTTP ${resp.status}): ${url}; ${DEGRADE_NOTE}`);
                sections.push(`## ${url}\n\n(index unavailable: HTTP ${resp.status})`);
                continue;
            }
            if (text.length > MAX_INDEX_BYTES) {
                warnings.push(`docs index truncated (${url} exceeds ${MAX_INDEX_BYTES} bytes); some page URLs may be missing`);
                sections.push(`## ${url}\n\n${text.slice(0, MAX_INDEX_BYTES)}\n(... truncated)`);
                continue;
            }
            sections.push(`## ${url}\n\n${text}`);
        } catch (e) {
            warnings.push(`docs index fetch failed (${String(e)}): ${url}; ${DEGRADE_NOTE}`);
            sections.push(`## ${url}\n\n(index unavailable: ${String(e)})`);
        }
    }
    return { body: sections.length ? sections.join(nl + nl) : null, warnings };
}

export default async function describe() {
    const { body, warnings } = await loadDocsIndexes();
    const docsBlock = body ? `${DOCS_SECTION}${nl}${nl}${body}` : DOCS_SECTION;
    return { prompt: `${SYSTEM_PROMPT}${nl}${nl}${docsBlock}`, tools_json: '[]', warnings };
}
