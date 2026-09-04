// obelisk-agent:tools/webapi.pause-execution:
//   func(execution-id: string) -> result<record { ok: bool,
//     execution-id: string, action: enum { pause, unpause, cancel, stub },
//     already: bool },
//     variant { permanent-error(string), transient-error(string), execution-failed }>
export default async function pause_execution(executionId) {
    try { return await putState(executionId, "pause", "paused"); }
    catch (error) { throw classifyActivityError(error); }
}

function classifyActivityError(error) {
    if (error?.permanent_error || error?.transient_error) return error;
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(/\bHTTP (\d+)/.exec(message)?.[1]);
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
    return permanent || (!status && !(error instanceof Error))
        ? { permanent_error: message } : { transient_error: message };
}

async function putState(executionId, action, idempotentStatus) {
    if (!executionId) throw "execution-id is required";
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/${action}`,
        { method: "PUT", headers: { accept: "application/json", authorization: `Bearer ${process.env["OBELISK_API_TOKEN"]}` } },
    );
    if (resp.ok) return { ok: true, execution_id: executionId, action, already: false };
    if (await hasStatus(base, executionId, idempotentStatus)) {
        return { ok: true, execution_id: executionId, action, already: true };
    }
    throw `HTTP ${resp.status}: ${await resp.text()}`;
}

async function hasStatus(base, executionId, status) {
    try {
        const resp = await fetch(
            `${base}/v1/executions/${encodeURIComponent(executionId)}/status`,
            { headers: { accept: "application/json", authorization: `Bearer ${process.env["OBELISK_API_TOKEN"]}` } },
        );
        if (!resp.ok) return false;
        const body = await resp.json();
        return body?.pending_state?.status === status;
    } catch (_) {
        return false;
    }
}
