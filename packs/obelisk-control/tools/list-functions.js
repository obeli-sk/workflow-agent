// obelisk-agent:tools/webapi.list-functions:
//   func(ffqn-prefix: string, length: u32) -> result<string, string>
// Returns each matching function's metadata plus its full WIT (interface with the
// single function and every type it references).
export default async function list_functions(ffqnPrefix, length) {
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(`${base}/v1/functions`, {
        headers: { accept: "application/json" },
    });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;

    const functions = await resp.json();
    if (!Array.isArray(functions)) throw "invalid functions response";
    const prefix = String(ffqnPrefix || "");
    const limit = length > 0 ? length : 100;
    const selected = functions
        .filter((item) => item && typeof item.ffqn === "string" && item.ffqn.startsWith(prefix))
        .slice(0, limit);

    const withWit = await Promise.all(selected.map(async (item) => ({
        ...item,
        wit: await fetchWit(base, item.ffqn),
    })));
    return JSON.stringify(withWit);
}

// Fetch the function's full WIT: the interface printed with only this function
// plus every type it references, so the signature stays self-contained.
async function fetchWit(base, ffqn) {
    try {
        const resp = await fetch(
            `${base}/v1/functions/wit?ffqn=${encodeURIComponent(ffqn)}`,
            { headers: { accept: "text/plain" } },
        );
        if (!resp.ok) return `<wit unavailable: HTTP ${resp.status}>`;
        return (await resp.text()).trim();
    } catch (e) {
        return `<wit unavailable: ${String(e)}>`;
    }
}
