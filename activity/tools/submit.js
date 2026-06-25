// obelisk-agent:tools/webapi.submit-json:
//   func(ffqn: string, params-json: string) -> result<string, string>
export default async function submit_json(ffqn, paramsJson) {
    if (!ffqn) throw "ffqn is required";

    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    let params;
    try { params = JSON.parse(paramsJson || "[]"); }
    catch (e) { throw await errorWithWit(base, ffqn, `params-json must be valid JSON: ${e.message}`); }
    if (!Array.isArray(params)) {
        throw await errorWithWit(base, ffqn, "params-json must be a JSON array of positional parameters");
    }

    const resp = await fetch(`${base}/v1/executions`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ ffqn, params }),
    });
    if (!resp.ok) {
        throw await errorWithWit(base, ffqn, `HTTP ${resp.status}: ${await resp.text()}`);
    }
    return await resp.text();
}

async function errorWithWit(base, ffqn, message) {
    try {
        const wit = await getFunctionWit(base, ffqn);
        return `${message}\n\nWIT for ${ffqn}:\n${wit}`;
    } catch (e) {
        return `${message}\n\nCould not fetch WIT for ${ffqn}: ${String(e)}`;
    }
}

async function getFunctionWit(base, ffqn) {
    const resp = await fetch(
        `${base}/v1/functions/wit?ffqn=${encodeURIComponent(ffqn)}`,
        { headers: { accept: "text/plain" } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
