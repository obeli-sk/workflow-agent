// obelisk-agent:config/config.discover:
//   func(execution-id: string, backend: string, effort: string, name: option<string>)
//     -> result<record {
//     max-steps: u32,
//     programs: list<record { name: string, ffqn: string, description: string }>,
//     mcp-servers: list<record { name: string, ffqn: string }>,
//     apps: list<record { name: string, owner: string, repo: string, ref: string, description: string }>,
//     webhook-url: string,
//     prompt-tail: string
//   }, string>
//
// prompt-tail is the whole system prompt after "# Example apps": user-input
// guidance, subagent delegation, deployment authoring, and the per-session
// "# This session" text - not operator config. It lives here (one JS
// activity both workflow backends already call at session start) so
// session.rs and session-logic.js don't each hand-carry their own copy of
// this prose, "# This session" included: execution-id/backend/effort/name
// are cheap to pass in (no network round trip either way), so there is no
// cost to fully centralizing it here too.

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_APP_OWNER = "obeli-sk";
const DEFAULT_APP_REF = "main";

// PORT-OF-RECORD: session.rs's inline "# User input" text and
// session-logic.js's (now-deleted) USER_INPUT_SECTION constant.
const USER_INPUT_SECTION =
    "# User input\n\n" +
    "When you need a user answer before you can continue the current task, run " +
    "`obelisk call obelisk-agent:stub/stub.ask-user '[\"Your question\"]'`. It publishes the question " +
    "to the UI, blocks, and returns the answer so you can continue in the same turn. Use it only when " +
    "the answer is required to proceed; to end the turn, reply in Markdown without a command.";

// PORT-OF-RECORD: session.rs's inline "# Subagents" text and
// session-logic.js's (now-deleted) SUBAGENTS_SECTION constant.
const SUBAGENTS_SECTION =
    "# Subagents\n\n" +
    "Delegate self-contained work with `chat create [--name slug] PROMPT`.\n\n" +
    "- Pass `--watch` (or call `chat watch ID`) to block until the child stops progressing: final-response, step-limit, awaiting-answer, shell-only, or a terminal state.\n" +
    "- The reported JSON includes a `final` field with the child's finished reply, error, or pending question, so you rarely need a follow-up read.\n" +
    "- When you do, use `chat read ID --final` (just that outcome) rather than a full `chat read ID` (the whole transcript, far more tokens); reach for the full read only when you need the reasoning trail.\n" +
    "- Never poll a child with sleep loops.\n" +
    "- A child parked in step-limit resumes where it left off when you send it `chat send ID continue`; its budget resets for the new turn.";

// PORT-OF-RECORD: vendor/just-bash-rs/src/obelisk_pack.rs's (now-deleted)
// SYSTEM_PROMPT constant and vendor/just-bash/src/obelisk-pack.js's matching
// (now-deleted) export - the "obelisk" shell command's own logic stays
// vendored/ported per backend, but this descriptive text has no per-backend
// behavior to port, so it belongs in exactly one place.
const PACK_SYSTEM_PROMPT =
    "# Deployment authoring\n\n" +
    "You are on a persistent virtual machine with a filesystem rooted at /workspace. The target " +
    "Obelisk's active deployment is at /workspace/deployment/current: read and edit its " +
    "deployment.toml and component sources with ordinary shell commands.\n\n" +
    "- Use `obelisk` for target-server operations: functions, executions, call, and deployment current/refresh/check/submit/switch/apply.\n" +
    "- Edits are local until deployed: `obelisk deployment submit` stores them as a new inactive deployment and prints its ID, `obelisk deployment apply ID` hot-redeploys that deployment, `obelisk deployment refresh` discards local edits and re-fetches the current one.\n" +
    "- Never set or maintain a digest: submit recomputes each from file bytes. Leave `content_digest` omitted, `component_files` entries as \"auto\", and `backtrace.sources` entries as plain path strings.\n" +
    "- Add a component by writing its source plus an `[[activity_js]]`/`[[workflow_js]]` table (name, location, params, return_type); add a bundled file by writing it and listing its path in `component_files` as \"auto\".\n" +
    "- Run `obelisk generate deployment` for a fully-commented starter deployment.toml.\n" +
    "- `obelisk executions list` hides webhook-spawned child executions unless `--show-derived` is passed.\n" +
    "- Fetch the docs index at https://obeli.sk/docs/latest/llms.txt/ with curl, then fetch any page it lists before writing components; never guess API signatures.\n" +
    "- Read-only reference repos for authoring are mounted at /workspace/apps/<name> (see \"Example apps\" above).\n" +
    "\n" +
    "# Mounts and network access\n\n" +
    "Run `mount` to see every mounted app, the network-backed mount points, and whether each MCP server is responding.\n\n" +
    "- `/workspace/deployment`, `/workspace/apps/*`, and `/workspace/mcp` are lazy: a directory lists and a file's bytes fetch over the network on first access.\n" +
    "- The deployment mount is cheap (one request for its whole file index); each `/workspace/apps/<name>` tree costs one request per directory listed - avoid `tree`, `find`, or a recursive grep across them, and use targeted `ls`/`cat` or read a known path directly instead.\n" +
    "- The shell's HTTP access goes through an operator allowlist: `curl` (GET only) works only for explicitly granted hosts; anything else is a policy-denied result, not a bug.\n" +
    "- The target's webhook base URL printed by `mount` is granted for GET, so deployed endpoints can be smoke-tested directly; verify anything else through the control plane (`obelisk executions list` / `logs`) instead of probing the port.\n";

// The fixed part of the prompt tail, in the order the workflow renders it:
// user input, then subagents, then deployment authoring. The per-session
// "# This session" text (built by renderSelfSection) follows this.
const STATIC_SECTIONS = [USER_INPUT_SECTION, SUBAGENTS_SECTION, PACK_SYSTEM_PROMPT].join("\n\n");

// PORT-OF-RECORD: session.rs's chat::self_section / (now-deleted)
// chat-logic.js's selfSection - the "# This session" paragraph: the
// session's own identity (exactly what `chat current` prints), its parent
// for context gathering, and when to rename itself.
function renderSelfSection(executionId, backend, effort, name) {
    const payload = JSON.stringify({
        execution_id: executionId,
        backend,
        effort,
        name: name ?? null,
        parent_id: parentOf(executionId),
    });
    let text =
        "# This session\n\n" +
        "`chat current` output for the session you are running in:\n" +
        `${payload}\n\n` +
        "Peers discover sessions by slug via `chat list`; read your own transcript " +
        `with \`chat read ${executionId}\`. If your starting prompt already makes the task clear, ` +
        "rename yourself first, before anything else (`chat rename <slug>`); " +
        "otherwise wait until the task settles into something nameable. Rename once " +
        "to a short kebab slug summarizing the task; do not rename repeatedly or " +
        "preemptively while it is still unclear.\n";
    const parent = parentOf(executionId);
    if (parent !== null) {
        text +=
            `\nYou were started as a child session by ${parent}. If your prompt ` +
            `leaves you short of context, run \`chat read ${parent}\` to see the transcript ` +
            "that created you.\n";
    }
    return text;
}

// PORT-OF-RECORD: chat.rs's parent_of / chat-logic.js's parentOf. The
// session that created an execution, derived from the derived-execution id
// shape (`<parent-id>.<join-set-ref>`); null for top-level executions.
function parentOf(executionId) {
    const dot = executionId.lastIndexOf(".");
    return dot === -1 ? null : executionId.slice(0, dot);
}

export default async function discover(executionId, backend, effort, name) {
    return {
        max_steps: parseMaxSteps(process.env["MAX_STEPS"]),
        programs: parseRegistry("PROGRAMS_JSON", parseProgram),
        mcp_servers: parseRegistry("MCP_SERVERS_JSON", parseMcpServer),
        apps: parseRegistry("APPS_JSON", parseApp),
        webhook_url: (process.env["TARGET_OBELISK_WEBHOOK_URL"] ?? "").trim(),
        // STATIC_SECTIONS already ends in one "\n" (from PACK_SYSTEM_PROMPT);
        // one more here yields the same blank-line gap as every other
        // section boundary in this prompt.
        prompt_tail: `${STATIC_SECTIONS}\n${renderSelfSection(executionId, backend, effort, name)}`,
    };
}

function parseMaxSteps(raw) {
    if (!raw || !raw.trim()) return DEFAULT_MAX_STEPS;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) {
        throw "MAX_STEPS must be an integer between 1 and 4294967295";
    }
    return value;
}

function parseRegistry(envName, parseEntry) {
    const raw = process.env[envName];
    if (!raw || !raw.trim()) return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw `${envName} is not valid JSON: ${error}`;
    }
    if (!Array.isArray(parsed)) throw `${envName} must be a JSON array`;
    return parsed.map((entry, index) => parseEntry(entry, index, envName));
}

function parseProgram(entry, index, envName) {
    const name = entry?.name;
    const ffqn = entry?.ffqn;
    const description = entry?.description ?? "";
    if (typeof name !== "string" || !name) throw `${envName}[${index}] has no name`;
    if (typeof ffqn !== "string" || !ffqn) throw `${envName}[${index}] has no ffqn`;
    if (typeof description !== "string") throw `${envName}[${index}] description must be a string`;
    return { name, ffqn, description };
}

function parseMcpServer(entry, index, envName) {
    const name = entry?.name;
    const ffqn = entry?.ffqn;
    if (typeof name !== "string" || !name) throw `${envName}[${index}] has no name`;
    if (typeof ffqn !== "string" || !ffqn) throw `${envName}[${index}] has no ffqn`;
    return { name, ffqn };
}

// An APPS_JSON entry: a lazily-mounted GitHub repo tree, browsed at
// /workspace/apps/<name> through the single obelisk-agent:mounts/apps.request
// activity (activity/github-contents.js). `owner`/`ref` default to the
// obeli-sk org's `main` branch so a typical entry is just `{name, repo}`.
function parseApp(entry, index, envName) {
    const name = entry?.name;
    const repo = entry?.repo;
    const owner = entry?.owner ?? DEFAULT_APP_OWNER;
    const ref = entry?.ref ?? DEFAULT_APP_REF;
    const description = entry?.description ?? "";
    if (typeof name !== "string" || !name) throw `${envName}[${index}] has no name`;
    if (typeof repo !== "string" || !repo) throw `${envName}[${index}] has no repo`;
    if (typeof owner !== "string" || !owner) throw `${envName}[${index}] owner must be a string`;
    if (typeof ref !== "string" || !ref) throw `${envName}[${index}] ref must be a string`;
    if (typeof description !== "string") throw `${envName}[${index}] description must be a string`;
    return { name, owner, repo, ref, description };
}
