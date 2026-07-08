// obelisk-agent:tools/webapi.pause-execution:
//   func(execution-id: string) -> result<string, string>
export default async function pause_execution(executionId) {
    return await putState(executionId, "pause", "paused");
}

async function putState(executionId, action, idempotentStatus) {
    if (!executionId) throw "execution-id is required";
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/${action}`,
        { method: "PUT", headers: { accept: "application/json" } },
    );
    if (resp.ok) return JSON.stringify({ ok: true, execution_id: executionId, action });
    if (await hasStatus(base, executionId, idempotentStatus)) {
        return JSON.stringify({ ok: true, execution_id: executionId, action, already: true });
    }
    throw `HTTP ${resp.status}: ${await resp.text()}`;
}

async function hasStatus(base, executionId, status) {
    try {
        const resp = await fetch(
            `${base}/v1/executions/${encodeURIComponent(executionId)}/status`,
            { headers: { accept: "application/json" } },
        );
        if (!resp.ok) return false;
        const body = await resp.json();
        return body?.pending_state?.status === status;
    } catch (_) {
        return false;
    }
}
