// obelisk-agent:tools/webapi.call-target:
//   func(ffqn: string, params-json: string) -> result<string, tool-error>
//
// Submits `ffqn` to the target Obelisk over HTTP and blocks (follow=true) for the
// result, returning the raw Execution Result envelope JSON ({ ok } / { err } /
// { execution_failed }); native.call parses it. A workflow can't fetch, so this
// activity is the durable HTTP replacement for the in-process obelisk.call, which
// only ever reaches the agent's own instance. POST auto-generates the execution
// id server-side; the deployment block sets max_retries = 0 so a transient
// failure never double-submits.
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
    const resp = await fetch(`${base}/v1/executions?follow=true`, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ffqn, params }),
    });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}

function classifyActivityError(error) {
    if (error?.permanent_error || error?.transient_error) return error;
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(/\bHTTP (\d+)/.exec(message)?.[1]);
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
    return permanent || (!status && !(error instanceof Error))
        ? { permanent_error: message } : { transient_error: message };
}
