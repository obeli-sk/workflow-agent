// obelisk-agent:tools/webapi.unpause-execution:
//   func(execution-id: string) -> result<string, string>
export default async function unpause_execution(executionId) {
    if (!executionId) throw "execution-id is required";
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/unpause`,
        { method: "PUT", headers: { accept: "application/json" } },
    );
    if (resp.ok) return JSON.stringify({ ok: true, execution_id: executionId, action: "unpause" });
    const status = await getStatus(base, executionId);
    if (status && status !== "paused") {
        return JSON.stringify({ ok: true, execution_id: executionId, action: "unpause", already: true });
    }
    throw `HTTP ${resp.status}: ${await resp.text()}`;
}

async function getStatus(base, executionId) {
    try {
        const resp = await fetch(
            `${base}/v1/executions/${encodeURIComponent(executionId)}/status`,
            { headers: { accept: "application/json" } },
        );
        if (!resp.ok) return null;
        const body = await resp.json();
        return body?.pending_state?.status || null;
    } catch (_) {
        return null;
    }
}
