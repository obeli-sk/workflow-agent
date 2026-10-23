// System-prompt descriptor for the "manage apps in the cloud" use case.
// The generic session loop calls this FFQN once at startup and prepends the
// returned prompt to its shell and user-input guidance.
//
// obelisk-control:agent/pack.describe:
//   func() -> result<record { prompt: string, tools-json: string }, string>
//
// The model's only tool is `bash`. `tools-json` is an unused compatibility
// field from the former model-facing catalog and is always empty.

import { cloudRequest } from "./cloud/client.js";
import { singleApp, singleAppRow } from "./cloud/single-app.js";

const nl = String.fromCharCode(10);

// Encoding rules for `obelisk cloud app call FFQN PARAMS_JSON`, the one shell command
// that takes a WIT-typed argument. The rest of the `obelisk` subcommands and
// the deployment edit/submit/apply flow are documented by the shell pack's own
// system prompt, which the core appends after this prompt.
const WIT_JSON_MAPPING = [
    '## Encoding params for `obelisk cloud app call`',
    '',
    '- Run `obelisk cloud app --help` for the subcommands; they use pairs such as `obelisk cloud app --app NAME functions list` and `obelisk cloud app --app NAME executions get ID`. Run `--help` (or `-h`) at any level for usage, e.g. `obelisk cloud app deployment submit --help`.',
    '- Inspect an app\'s signatures with `obelisk cloud app --app NAME functions list` before calling one when the parameter types are not already known.',
    '- Call with a JSON array (`obelisk cloud app --app NAME call FFQN \'[1,"text"]\'`) or positional values (`... call FFQN -- 1 text`); positional values parse as JSON when valid and otherwise as strings.',
    '- A successful call prints only the function\'s return value; a `result` err or execution failure exits nonzero and prints the error to stderr.',
    '- params-json is a JSON array of positional arguments in WIT parameter order; kebab-case identifiers become snake_case JSON keys and variant/enum values.',
    '- `bool` maps to JSON `true`/`false`; `char`/`string` map to JSON strings.',
    '- Integers and floats map to JSON numbers; Obelisk rejects lossy numeric conversions instead of rounding.',
    '- `option<T>` maps to the JSON value for T or `null` for none; `list<T>` maps to a JSON array; `tuple<T1, T2>` maps to a JSON array in tuple order.',
    '- `record { field-name: T }` maps to a JSON object such as `{"field_name": value}`.',
    '- `variant { case-name(T) }` maps to a JSON string for no-payload cases or an object such as `{"case_name": value}` for payload cases; `enum { case-name }` maps to the JSON string `"case_name"`.',
    '- `flags { flag-name }` maps to an array of active flag strings such as `["flag_name"]`.',
    '- `result<T, E>` maps to `{"ok": value}` or `{"err": value}`; result with no payload uses `null`.',
].join(nl);

const SYSTEM_PROMPT = [
    'You are the planner inside an Obelisk durable workflow that manages apps in the cloud. Use `obelisk cloud` to discover and manage apps, and `deployment pull DIRECTORY` to edit an existing deployment.',
    '',
    '- Investigate, plan, and decide which durable actions are needed. Act through bash: shell commands and `obelisk` for durable, replayable actions that appear in the Obelisk execution log; built-in reasoning for the rest.',
    '- Narrate as you work: a short Markdown note alongside each tool call saying what you are about to run and why. Text and a tool call in one response are both kept, and the turn continues.',
    '- A response with no tool call ends the turn and hands control back to the user: send your final answer, or a non-blocking question, as Markdown with no command attached (fenced Mermaid blocks only for diagrams). For an answer required before you can continue, use the UI-coordinated `ask-user` command (see the shell guidance).',
    '- Never invent execution IDs, FFQNs, deployment IDs, or command arguments - discover them first. If a command errors, retry, try another command, ask the user, or explain; do not guess.',
    '',
    '# Peer sessions',
    '',
    'Other agent sessions on this instance are peers you can talk to:',
    '',
    '- Discover them with `chat list` (never invent IDs); inspect one with `chat state`.',
    '- Queue a message with `chat send ID text` (delivered when idle, queued while busy).',
    '- Delegate work to a new child with `chat create` - see "Subagents" below for watching it to completion.',
    '- Use peers for parallel or isolated work, not to bypass your own durability.',
    '',
    '# Authoring JS workflows',
    '',
    'Follow the Obelisk authoring guidance in the rendered llms.txt below. Fetch the linked API pages before writing components or calling unfamiliar host functions.',
    '',
    WIT_JSON_MAPPING,
].join(nl);

const DOCS_SECTION = [
    '# Obelisk documentation (rendered llms.txt)',
    '',
    'The rendered index below is the source of truth for app authoring and links every docs page. Fetch relevant pages with the GET-only curl program, e.g. `curl https://obeli.sk/docs/latest/js/js-workflows/ | sed -n 1,200p`.',
].join(nl);

// Docs indexes fetched once at session start and inlined into the prompt.
// DOCS_URLS_JSON (deployment.toml; default: the current llms.txt for this
// Obelisk version, falling back to latest) lists the indexes; fetching here keeps
// the doc set pinned to the deployed Obelisk without hardcoding anything that could drift. Any
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
            let resp = await fetch(url);
            let heading = url;
            // Unreleased versions (e.g. release candidates) have no published docs.
            const latest = url.replace(/\/docs\/[^/]+\//, "/docs/latest/");
            if (!resp.ok && latest !== url) {
                const status = resp.status;
                resp = await fetch(latest);
                heading = `${latest} (${url} returned HTTP ${status})`;
            }
            const text = await resp.text();
            if (!resp.ok) {
                warnings.push(`docs index fetch failed (HTTP ${resp.status}): ${heading}; ${DEGRADE_NOTE}`);
                sections.push(`## ${heading}\n\n(index unavailable: HTTP ${resp.status})`);
                continue;
            }
            if (text.length > MAX_INDEX_BYTES) {
                warnings.push(`docs index truncated (${heading} exceeds ${MAX_INDEX_BYTES} bytes); some page URLs may be missing`);
                sections.push(`## ${heading}\n\n${text.slice(0, MAX_INDEX_BYTES)}\n(... truncated)`);
                continue;
            }
            sections.push(`## ${heading}\n\n${text}`);
        } catch (e) {
            warnings.push(`docs index fetch failed (${String(e)}): ${url}; ${DEGRADE_NOTE}`);
            sections.push(`## ${url}\n\n(index unavailable: ${String(e)})`);
        }
    }
    return { body: sections.length ? sections.join(nl + nl) : null, warnings };
}

const APP_COMMANDS = [
    '- `obelisk cloud apps list`; `obelisk cloud app --app NAME status|get|endpoint`. `--app` may be left out inside a directory whose app.toml names the app, or when there is only one app.',
    '- The app\'s own API: `obelisk cloud app --app NAME functions list|wit FFQN`, `executions list|get ID|logs ID|result ID`, `call FFQN PARAMS`, `deployment active|list|show|pull|check|submit|enqueue|apply`.',
    '- `obelisk cloud app --app NAME executions list` hides webhook-spawned child executions unless `--show-derived` is passed.',
    '- Pull an existing deployment with `obelisk cloud app --app NAME deployment pull DIRECTORY`. Edit the pulled files and inspect app.toml for the app policy; a deployment cannot grant itself additional permissions.',
];

const CLOUD_SECTION = [
    '# Cloud apps',
    '',
    'Use `obelisk cloud` to manage available apps (run `obelisk cloud --help`). Some apps restrict provisioning, configuration or lifecycle commands; follow the reported permissions.',
    '',
    ...APP_COMMANDS,
    '- Create and deploy from the working directory: write `app.toml` (with `app_name`) and `deployment.toml`, then `obelisk cloud app deploy -a app.toml -d deployment.toml`. It creates or restages the app, applies and starts it, uploads the deployment and prints the webhook URL.',
    '- Config: `obelisk cloud app --app NAME env list|set NAME VALUE|unset NAME` and `secrets list|set NAME --stdin|set NAME --from-env VAR|unset NAME`; then `obelisk cloud app --app NAME apply`.',
    '- Destructive commands (`delete`, `deactivate`) need the user\'s confirmation first.',
].join(nl);

// The cloud section: ObeliskNet with OBELISK_CLOUD_API_TOKEN, else the single-app cloud.
async function cloudSection() {
    try {
        let listed;
        if (singleApp()) {
            listed = { apps: [await singleAppRow()] };
        } else if (process.env["OBELISK_CLOUD_API_TOKEN"]) {
            listed = await cloudRequest("GET", ["v1", "apps"]);
        } else {
            return { section: null, warnings: ["No cloud is configured; `obelisk cloud` is left out of the prompt"] };
        }
        const apps = (Array.isArray(listed?.apps) ? listed.apps : [])
            .map((app) => `- ${app?.app_name}: ${app?.status ?? "unknown"}`);
        const existing = apps.length ? `Existing apps:${nl}${nl}${apps.join(nl)}` : 'No apps exist yet.';
        return { section: `${CLOUD_SECTION}${nl}${nl}${existing}`, warnings: [] };
    } catch (error) {
        return { section: null, warnings: [`The cloud is configured but unreachable (${String(error)}); \`obelisk cloud\` is left out of the prompt`] };
    }
}

export default async function describe() {
    const { body, warnings } = await loadDocsIndexes();
    const cloud = await cloudSection();
    const docsBlock = body ? `${DOCS_SECTION}${nl}${nl}${body}` : DOCS_SECTION;
    const sections = [SYSTEM_PROMPT, cloud.section, docsBlock].filter((section) => section !== null);
    return { prompt: sections.join(`${nl}${nl}`), tools_json: '[]', warnings: [...warnings, ...cloud.warnings] };
}
