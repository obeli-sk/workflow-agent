// obelisk-agent:config/config.discover:
//   func() -> result<record {
//     max-steps: u32,
//     programs: list<record { name: string, ffqn: string, description: string }>,
//     mcp-servers: list<record { name: string, ffqn: string }>,
//     apps: list<record { name: string, owner: string, repo: string, ref: string }>,
//     webhook-url: string
//   }, string>

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_APP_OWNER = "obeli-sk";
const DEFAULT_APP_REF = "main";

export default async function discover() {
    return {
        max_steps: parseMaxSteps(process.env["MAX_STEPS"]),
        programs: parseRegistry("PROGRAMS_JSON", parseProgram),
        mcp_servers: parseRegistry("MCP_SERVERS_JSON", parseMcpServer),
        apps: parseRegistry("APPS_JSON", parseApp),
        webhook_url: (process.env["TARGET_OBELISK_WEBHOOK_URL"] ?? "").trim(),
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
    if (typeof name !== "string" || !name) throw `${envName}[${index}] has no name`;
    if (typeof repo !== "string" || !repo) throw `${envName}[${index}] has no repo`;
    if (typeof owner !== "string" || !owner) throw `${envName}[${index}] owner must be a string`;
    if (typeof ref !== "string" || !ref) throw `${envName}[${index}] ref must be a string`;
    return { name, owner, repo, ref };
}
