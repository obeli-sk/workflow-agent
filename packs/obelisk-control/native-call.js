// Generic "call any deployed Obelisk function" tool for the obelisk-control pack.
// The agent controls an external system by calling deployed functions; this
// workflow runs one such call natively (durable, replayable) and returns its
// result as JSON. The target ffqn is chosen at runtime by the model, so this
// cannot be a fixed leaf activity.
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
    try {
        const result = obelisk.call(ffqn, params);
        return JSON.stringify({ ffqn, result: result === undefined ? null : result });
    } catch (e) { throw witHint(ffqn, callErrorMessage(e)); }
}

// On error, append the target WIT so the model can correct its parameters.
function witHint(ffqn, message) {
    try { return `${message}\n\nWIT for ${ffqn}:\n${webapi.getFunctionWit(ffqn)}`; }
    catch (e) { return `${message}\n\nCould not fetch WIT for ${ffqn}: ${String(e)}`; }
}

function callErrorMessage(e) {
    if (e instanceof obelisk.ChildExecutionError) {
        if (e.value !== undefined) return typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
        return e.message;
    }
    return String(e);
}
