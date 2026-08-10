// obelisk-agent:tools/webapi.stub-execution:
//   func(execution-id: string, result-json: string) -> result<record { ok: bool,
//     execution-id: string, action: enum { pause, unpause, cancel, stub },
//     already: bool },
//     variant { permanent-error(string), transient-error(string), execution-failed }>
export default async function stub_execution(executionId, resultJson) {
    try { return await stub_execution_impl(executionId, resultJson); }
    catch (error) { throw classifyActivityError(error); }
}

async function stub_execution_impl(executionId, resultJson) {
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
            headers: { accept: "application/json", authorization: `Bearer ${process.env["OBELISK__API__TOKEN"]}`, "content-type": "application/json" },
            body: JSON.stringify(result),
        },
    );
    if (resp.ok) return { ok: true, execution_id: executionId, action: "stub", already: false };
    if (await isTerminal(base, executionId)) {
        return { ok: true, execution_id: executionId, action: "stub", already: true };
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
            { headers: { accept: "application/json", authorization: `Bearer ${process.env["OBELISK__API__TOKEN"]}` } },
        );
        if (!resp.ok) return false;
        const body = await resp.json();
        const status = body?.pending_state?.status || "";
        return status === "finished" || /^permanently/.test(status);
    } catch (_) {
        return false;
    }
}
