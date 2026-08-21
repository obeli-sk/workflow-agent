// obelisk-agent:mcp/registry.discover:
//   func() -> result<list<record { name: string, ffqn: string }>, string>
//
// The MCP server registry: which stateless MCP transport activities the session
// should wire up as shell commands and lazily mount. Configured operator-side as
// a JSON array in the MCP_SERVERS_JSON env var, one entry per server:
//   [{ "name": "obelisk-local", "ffqn": "obelisk-agent:mcp/server.obelisk-local" }]
// `name` is the server name (its shell command and /workspace/mcp/<name> dir);
// `ffqn` is its deployed transport activity. The WIT return type structurally
// enforces the shape, so a malformed entry fails the activity rather than
// silently mis-wiring a server. An unset or empty var means no MCP servers.
export default async function discover() {
    const raw = process.env["MCP_SERVERS_JSON"];
    if (!raw || !raw.trim()) return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw `MCP_SERVERS_JSON is not valid JSON: ${error}`;
    }
    if (!Array.isArray(parsed)) throw "MCP_SERVERS_JSON must be a JSON array";
    return parsed.map((entry, index) => {
        const name = entry?.name;
        const ffqn = entry?.ffqn;
        if (typeof name !== "string" || !name) throw `MCP_SERVERS_JSON[${index}] has no name`;
        if (typeof ffqn !== "string" || !ffqn) throw `MCP_SERVERS_JSON[${index}] has no ffqn`;
        return { name, ffqn };
    });
}
