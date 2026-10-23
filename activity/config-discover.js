// obelisk-agent:config/config.discover:
//   func(execution-id: string, backend: string, effort: string, name: option<string>)
//     -> result<record {
//     max-steps: u32,
//     programs: list<record { name: string, ffqn: string, description: string }>,
//     apps: list<record { name: string, owner: string, repo: string, ref: string, description: string }>,
//     obelisk-version: string,
//     prompt-tail: string
//   }, string>
//
// prompt-tail is the whole system prompt after "# Example apps": user-input
// guidance, subagent delegation, deployment authoring, and the per-session
// "# This session" text - not operator config.

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_APP_OWNER = "obeli-sk";
const DEFAULT_APP_REF = "main";

const USER_INPUT_SECTION =
    "# User input\n\n" +
    "When you need a user answer before you can continue the current task, run " +
    "`obelisk call obelisk-agent:stub/stub.ask-user '[\"Your question\"]'`. It publishes the question " +
    "to the UI, blocks, and returns the answer so you can continue in the same turn. Use it only when " +
    "the answer is required to proceed; to end the turn, reply in Markdown without a command.";

const SUBAGENTS_SECTION =
    "# Subagents\n\n" +
    "Delegate self-contained work with `chat create [--name slug] PROMPT`.\n\n" +
    "- Pass `--watch` (or call `chat watch ID`) to block until the child stops progressing: final-response, step-limit, awaiting-answer, shell-only, or a terminal state.\n" +
    "- The reported JSON includes a `final` field with the child's finished reply, error, or pending question, so you rarely need a follow-up read.\n" +
    "- When you do, use `chat read ID --final` (just that outcome) rather than a full `chat read ID` (the whole transcript, far more tokens); reach for the full read only when you need the reasoning trail.\n" +
    "- Never poll a child with sleep loops.\n" +
    "- A child parked in step-limit resumes where it left off when you send it `chat send ID continue`; its budget resets for the new turn.";

const PACK_SYSTEM_PROMPT =
    "# Deployment authoring\n\n" +
    "You are on a persistent virtual machine with a filesystem rooted at /workspace. Pull an app's " +
    "deployment into a working directory and edit deployment.toml and component sources with ordinary shell commands.\n\n" +
    "- Use `obelisk cloud app --app NAME ...` for an app's operations: functions, executions, call, and deployment active/list/show/pull/check/submit/enqueue/apply.\n" +
    "- Edits are local until deployed: `obelisk cloud app --app NAME deployment submit PATH` stores them as a new inactive deployment and prints its ID, `deployment apply ID` hot-redeploys that deployment now, `deployment enqueue ID` stages it for the next server restart instead, and `deployment pull DIRECTORY` checks out the active deployment into an empty directory.\n" +
    "- Pull before editing an existing app: `obelisk cloud app --app NAME deployment pull /workspace/NAME`. It pins the active deployment, fetches its manifest, policy and file index, and loads source bytes only when read. Pull into a new directory to inspect a newer deployment without losing local edits.\n" +
    "- Add a component by writing its source plus an `[[activity_js]]`/`[[workflow_js]]` table (name, location, params, return_type); add a bundled JavaScript file by writing it and importing it from the component.\n" +
    "- Run `obelisk generate deployment` for a fully-commented starter deployment.toml, or `obelisk generate new` to list the starter app templates.\n" +
    "- Follow the rendered llms.txt authoring guidance in the system prompt and fetch relevant linked pages before writing components; never guess API signatures.\n" +
    "- Read-only reference repos for authoring are mounted at /workspace/apps/<name> (see \"Example apps\" above).\n" +
    "\n" +
    "# Mounts and network access\n\n" +
    "Run `mount` to see every mounted app and its network-backed mount point.\n\n" +
    "- `/workspace/apps/*` are lazy: a directory lists and a file's bytes fetch over the network on first access.\n" +
    "- Each `/workspace/apps/<name>` tree costs one request per directory listed - avoid `tree`, `find`, or a recursive grep across them, and use targeted `ls`/`cat` or read a known path directly instead.\n" +
    "- The shell's HTTP access goes through an operator allowlist: `curl` (GET only) works only for explicitly granted hosts; anything else is a policy-denied result, not a bug.\n" +
    "- Discover an app's webhook URL with `obelisk cloud app --app NAME endpoint webhook` and smoke-test its routes with `curl`. Verify executions through the app's API (`obelisk cloud app --app NAME executions list` / `logs`).\n";

// The fixed part of the prompt tail, in the order the workflow renders it:
// user input, then subagents, then deployment authoring. The per-session
// "# This session" text (built by renderSelfSection) follows this.
const STATIC_SECTIONS = [USER_INPUT_SECTION, SUBAGENTS_SECTION, PACK_SYSTEM_PROMPT].join("\n\n");

// The "# This session" paragraph: the session's own identity (exactly what
// `chat current` prints), its parent for context gathering, and when to rename
// itself.
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

// The session that created an execution, derived from the derived-execution id
// shape (`<parent-id>.<join-set-ref>`); null for top-level executions.
function parentOf(executionId) {
    const dot = executionId.lastIndexOf(".");
    return dot === -1 ? null : executionId.slice(0, dot);
}

export default async function discover(executionId, backend, effort, name) {
    return {
        max_steps: parseMaxSteps(process.env["MAX_STEPS"]),
        programs: parseRegistry("PROGRAMS_JSON", parseProgram),
        apps: parseRegistry("APPS_JSON", parseApp),
        obelisk_version: (process.env["OBELISK_VERSION"] ?? "").trim() || "latest",
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
