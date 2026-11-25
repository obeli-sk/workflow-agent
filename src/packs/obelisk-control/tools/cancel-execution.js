// obelisk-agent:tools/webapi.cancel-execution:
//   func(execution-id: string) -> result<record { ok: bool,
//     execution-id: string, action: enum { pause, unpause, cancel, stub },
//     already: bool },
//     variant { permanent-error(string), transient-error(string), execution-failed }>
export default async function cancel_execution(executionId) {
    try { return await cancel_execution_impl(executionId); }
    catch (error) { throw classifyActivityError(error); }
}

async function cancel_execution_impl(executionId) {
    if (!executionId) throw "execution-id is required";
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/cancel`,
        { method: "PUT", headers: { accept: "application/json", authorization: `Bearer ${process.env["OBELISK_API_TOKEN"]}` } },
    );
    if (resp.ok) return { ok: true, execution_id: executionId, action: "cancel", already: false };
    if (await isTerminal(base, executionId)) {
        return { ok: true, execution_id: executionId, action: "cancel", already: true };
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

async function isTerminal(base, executionId) {
    try {
        const resp = await fetch(
            `${base}/v1/executions/${encodeURIComponent(executionId)}/status`,
            { headers: { accept: "application/json", authorization: `Bearer ${process.env["OBELISK_API_TOKEN"]}` } },
        );
        if (!resp.ok) return false;
        const body = await resp.json();
        const status = body?.pending_state?.status || "";
        return status === "finished" || /^permanently/.test(status);
    } catch (_) {
        return false;
    }
}
