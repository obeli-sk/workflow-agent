// obelisk-agent:programs/registry.discover:
//   func() -> result<list<record {
//     name: string, ffqn: string, description: string
//   }>, string>
//
// The shell-program registry: which Obelisk-backed programs the session should
// wire up as shell commands. Configured operator-side as a JSON array in the
// PROGRAMS_JSON env var, one entry per program:
//   [{ "name": "curl", "ffqn": "obelisk-agent:programs/program.curl",
//      "description": "GET-only HTTP client" }]
// `name` is the shell command name; `ffqn` is its deployed program activity
// (contract `func(stdin, args) -> result<record { stdout, stderr, exit-code }>`);
// `description` is the one-line blurb the workflow puts in the system prompt so
// the model knows the command exists and what it does. The WIT return type
// structurally enforces the shape, so a malformed entry fails the activity
// rather than silently mis-wiring a command. An unset or empty var means no
// programs.
export default async function discover() {
    const raw = process.env["PROGRAMS_JSON"];
    if (!raw || !raw.trim()) return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw `PROGRAMS_JSON is not valid JSON: ${error}`;
    }
    if (!Array.isArray(parsed)) throw "PROGRAMS_JSON must be a JSON array";
    return parsed.map((entry, index) => {
        const name = entry?.name;
        const ffqn = entry?.ffqn;
        const description = entry?.description ?? "";
        if (typeof name !== "string" || !name) throw `PROGRAMS_JSON[${index}] has no name`;
        if (typeof ffqn !== "string" || !ffqn) throw `PROGRAMS_JSON[${index}] has no ffqn`;
        if (typeof description !== "string") throw `PROGRAMS_JSON[${index}] description must be a string`;
        return { name, ffqn, description };
    });
}
