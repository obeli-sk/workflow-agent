// Generic "call any deployed Obelisk function" tool for the obelisk-control pack.
// The agent controls the target Obelisk by calling its deployed functions; this
// workflow submits one such call to the target and returns its result as JSON.
// The target ffqn is chosen at runtime by the model, so this cannot be a fixed
// leaf activity.
//
// The target may be a different instance than the one the agent runs on, so the
// call goes over HTTP: a workflow can't fetch, so it delegates to the
// webapi.call-target activity (POST /v1/executions?follow=true against the
// target) instead of obelisk.call, which only ever reaches the agent's own
// instance.
//
// obelisk-control:tools/native.call:
//   func(ffqn: string, params-json: string) -> result<string, string>

import * as webapi from 'obelisk-agent:tools/webapi';

export default function call(ffqn, paramsJson) {
    if (typeof ffqn !== 'string' || !ffqn) throw 'ffqn is required';
    let params;
    try { params = JSON.parse(paramsJson || '[]'); }
    catch (e) { throw witHint(ffqn, `params_json must be valid JSON: ${e.message}`); }
    if (!Array.isArray(params)) throw witHint(ffqn, 'params_json must be a JSON array of positional parameters');

    let envelopeText;
    try { envelopeText = webapi.callTarget(ffqn, JSON.stringify(params)); }
    catch (e) { throw witHint(ffqn, callErrorMessage(e)); }

    // The target Execution Result envelope: { ok } / { err } / { execution_failed }.
    // Mirror the old obelisk.call contract: return the ok value, throw on the rest.
    let envelope;
    try { envelope = JSON.parse(envelopeText); }
    catch (e) { throw witHint(ffqn, `invalid execution result: ${e.message}: ${envelopeText}`); }
    if (envelope && Object.prototype.hasOwnProperty.call(envelope, 'ok')) {
        return JSON.stringify(envelope.ok === undefined ? null : envelope.ok);
    }
    if (envelope && Object.prototype.hasOwnProperty.call(envelope, 'err')) {
        throw witHint(ffqn, typeof envelope.err === 'string' ? envelope.err : JSON.stringify(envelope.err));
    }
    if (envelope && envelope.execution_failed) {
        const f = envelope.execution_failed;
        throw witHint(ffqn, f.reason || f.kind || 'execution failed');
    }
    throw witHint(ffqn, `unexpected execution result: ${envelopeText}`);
}

// On error, append the target WIT so the model can correct its parameters.
function witHint(ffqn, message) {
    try { return `${message}\n\nWIT for ${ffqn}:\n${webapi.getFunctionWit(ffqn)}`; }
    catch (e) { return `${message}\n\nCould not fetch WIT for ${ffqn}: ${String(e)}`; }
}

function callErrorMessage(e) {
    if (e instanceof obelisk.ChildError) {
        if (e.value !== undefined) return typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
        return e.message;
    }
    return String(e);
}
