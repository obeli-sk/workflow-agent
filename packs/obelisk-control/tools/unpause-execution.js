// obelisk-agent:tools/webapi.unpause-execution:
//   func(execution-id: string) -> result<record { ok: bool,
//     execution-id: string, action: enum { pause, unpause, cancel, stub },
//     already: bool },
//     variant { permanent-error(string), transient-error(string), execution-failed }>
export default async function unpause_execution(executionId) {
    try { return await unpause_execution_impl(executionId); }
    catch (error) { throw classifyActivityError(error); }
}

async function unpause_execution_impl(executionId) {
    if (!executionId) throw "execution-id is required";
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/unpause`,
        { method: "PUT", headers: { accept: "application/json", authorization: `Bearer ${process.env["OBELISK_API_TOKEN"]}` } },
    );
    if (resp.ok) return { ok: true, execution_id: executionId, action: "unpause", already: false };
    const status = await getStatus(base, executionId);
    if (status && status !== "paused") {
        return { ok: true, execution_id: executionId, action: "unpause", already: true };
    }
    throw `HTTP ${resp.status}: ${await resp.text()}`;
}

function classifyActivityError(error) {
    if (error?.permanent_error || error?.transient_error) return error;
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(/\bHTTP (\d+)/.exec(message)?.[1]);
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
    return permanent || (!status && !(error instanceof Error))
        ? { permanent_error: message } : { transient_error: message };
}

async function getStatus(base, executionId) {
    try {
        const resp = await fetch(
            `${base}/v1/executions/${encodeURIComponent(executionId)}/status`,
            { headers: { accept: "application/json", authorization: `Bearer ${process.env["OBELISK_API_TOKEN"]}` } },
        );
        if (!resp.ok) return null;
        const body = await resp.json();
        return body?.pending_state?.status || null;
    } catch (_) {
        return null;
    }
}
