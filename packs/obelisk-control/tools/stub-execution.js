// obelisk-agent:tools/webapi.stub-execution:
//   func(execution-id: string, result-json: string) -> result<string, string>
export default async function stub_execution(executionId, resultJson) {
    if (!executionId) throw "execution-id is required";
    let result;
    try { result = JSON.parse(resultJson); }
    catch (e) { throw `result-json must be valid JSON: ${e.message}`; }
    if (!result || typeof result !== "object" || (!("ok" in result) && !("err" in result))) {
        throw "result-json must be an object with ok or err";
    }

    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/stub`,
        {
            method: "PUT",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(result),
        },
    );
    if (resp.ok) return JSON.stringify({ ok: true, execution_id: executionId, action: "stub" });
    if (await isTerminal(base, executionId)) {
        return JSON.stringify({ ok: true, execution_id: executionId, action: "stub", already: true });
    }
    throw `HTTP ${resp.status}: ${await resp.text()}`;
}

async function isTerminal(base, executionId) {
    try {
        const resp = await fetch(
            `${base}/v1/executions/${encodeURIComponent(executionId)}/status`,
            { headers: { accept: "application/json" } },
        );
        if (!resp.ok) return false;
        const body = await resp.json();
        const status = body?.pending_state?.status || "";
        return status === "finished" || /^permanently/.test(status);
    } catch (_) {
        return false;
    }
}
