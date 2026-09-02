// PORT: workflow/workflow-rs/src/host.rs (the `RealHost` half only; the
// `ask-user` native-call interception lives in session.js since it needs the
// session's own Notifications/join-set state, which this file deliberately
// stays free of).
//
// Bridges the generic `callJson(ffqn, paramsJson) -> string|null` seam that
// vendor/just-bash's obelisk-pack.js/obelisk-mcp.js/obelisk-web.js/
// obelisk-program.js are written against (mirroring workflow-rs's
// `ObeliskHost` trait / the `obelisk:workflow/workflow-support.call-json` WIT
// host import, which returns a value's raw JSON text) onto `obelisk.call`,
// whose JS binding already returns the *decoded* value. Re-encoding that
// value with `JSON.stringify` here reproduces call-json's contract (JSON
// text, quoted for a string result; `null` for a void result) so every
// consumer's `decodeString`/`decodeJson`-style peeling ports unchanged from
// the Rust source instead of needing a second, JS-specific decode path.
//
// `obelisk-control:tools/native.call` needs no special case here: it is just
// another ffqn, called the same way as any `obelisk-agent:tools/webapi.*`
// call (see obelisk-pack.js's `targetCall`, which calls this seam with
// `ffqn = "obelisk-control:tools/native.call"`).

export function createHost() {
    return {
        callJson(ffqn, paramsJson) {
            let params;
            try {
                params = JSON.parse(paramsJson ?? "[]");
            } catch (error) {
                throw `params_json must be valid JSON: ${error.message}`;
            }
            let value;
            try {
                value = obelisk.call(ffqn, params);
            } catch (error) {
                throw childErrorMessage(error);
            }
            return value === undefined ? null : JSON.stringify(value);
        },
    };
}

// PORT: support.rs's `child_error_message` / the JS callers' inline
// equivalent (e.g. packs/obelisk-control/native-call.js's `callErrorMessage`).
function childErrorMessage(error) {
    if (typeof obelisk !== "undefined" && error instanceof obelisk.ChildError) {
        if (error.value !== undefined) {
            return typeof error.value === "string" ? error.value : JSON.stringify(error.value);
        }
        return error.message;
    }
    return String(error);
}
