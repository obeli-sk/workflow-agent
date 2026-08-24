// obelisk-agent:config/config.discover:
//   func() -> result<record {
//     max-steps: u32,
//     programs: list<record { name: string, ffqn: string, description: string }>,
//     mcp-servers: list<record { name: string, ffqn: string }>
//   }, string>

const DEFAULT_MAX_STEPS = 10;

export default async function discover() {
    return {
        max_steps: parseMaxSteps(process.env["MAX_STEPS"]),
        programs: parseRegistry("PROGRAMS_JSON", parseProgram),
        mcp_servers: parseRegistry("MCP_SERVERS_JSON", parseMcpServer),
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
