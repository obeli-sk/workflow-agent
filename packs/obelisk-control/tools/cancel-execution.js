// obelisk-agent:tools/webapi.cancel-execution:
//   func(execution-id: string) -> result<string, string>
export default async function cancel_execution(executionId) {
    if (!executionId) throw "execution-id is required";
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/cancel`,
        { method: "PUT", headers: { accept: "application/json" } },
    );
    if (resp.ok) return JSON.stringify({ ok: true, execution_id: executionId, action: "cancel" });
    if (await isTerminal(base, executionId)) {
        return JSON.stringify({ ok: true, execution_id: executionId, action: "cancel", already: true });
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
