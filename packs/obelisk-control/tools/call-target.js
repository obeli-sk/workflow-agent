// obelisk-agent:tools/webapi.call-target:
//   func(ffqn: string, params-json: string) -> result<string, tool-error>
//
// Submits `ffqn` to the target Obelisk, then follows the accepted execution by
// ID. The wrapper preserves whether the server rejected the submission or an
// accepted execution later returned an error. A workflow can't fetch, so this
// activity is the durable HTTP replacement for the in-process obelisk.call.
export default async function call_target(ffqn, paramsJson) {
    try { return await call_target_impl(ffqn, paramsJson); }
    catch (error) { throw classifyActivityError(error); }
}

async function call_target_impl(ffqn, paramsJson) {
    if (typeof ffqn !== "string" || !ffqn) throw "ffqn is required";
    let params;
    try { params = JSON.parse(paramsJson || "[]"); }
    catch (e) { throw `params_json must be valid JSON: ${e.message}`; }
    if (!Array.isArray(params)) throw "params_json must be a JSON array of positional parameters";

    const base = process.env["TARGET_OBELISK_API_URL"];
    if (!base) throw "TARGET_OBELISK_API_URL is not configured";
    const token = process.env["TARGET_OBELISK_TOKEN"];
    const headers = {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
    };
    const resp = await fetch(`${base}/v1/executions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ffqn, params }),
    });
    const submissionText = await resp.text();
    if (!resp.ok) {
        return JSON.stringify({ submission_rejected: responseError(resp.status, submissionText) });
    }

    let executionId;
    try { executionId = JSON.parse(submissionText)?.ok; }
    catch (_) { /* reported below */ }
    if (typeof executionId !== "string" || !executionId) {
        throw `invalid submission response: ${submissionText}`;
    }

    try {
        const resultResp = await fetch(
            `${base}/v1/executions/${encodeURIComponent(executionId)}?follow=true`,
            { headers },
        );
        const resultText = await resultResp.text();
        if (!resultResp.ok) {
            return JSON.stringify({ execution_id: executionId, result_error: responseError(resultResp.status, resultText) });
        }
        return JSON.stringify({ execution_id: executionId, result: resultText });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ execution_id: executionId, result_error: message });
    }
}

function responseError(status, text) {
    try {
        const reason = JSON.parse(text)?.err;
        if (typeof reason === "string" && reason) return `HTTP ${status}: ${reason}`;
    } catch (_) { /* use the response body */ }
    return `HTTP ${status}: ${text}`;
}

function classifyActivityError(error) {
    if (error?.permanent_error || error?.transient_error) return error;
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(/\bHTTP (\d+)/.exec(message)?.[1]);
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
    return permanent || (!status && !(error instanceof Error))
        ? { permanent_error: message } : { transient_error: message };
}
