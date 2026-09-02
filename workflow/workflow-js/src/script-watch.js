// PORT: workflow/workflow-rs/src/script_watch.rs
//
// Host-facing half of the per-script watch: submits the real interrupt
// offer (plus an optional watchdog delay) onto a fresh `obelisk`
// join set and hands back a `ScriptWatchGuard`. All the actual
// classification/poll/sleep logic lives in script-watch-logic.js, kept pure
// so it's unit-testable under plain `node --test`; this file is the thin
// WIT-touching wrapper, the same split session.js/session-logic.js already
// use. Not wired into session.js yet -- that integration (arming a guard
// around each shell exec, publishing `shell-started`, propagating
// `interrupted` into the transcript) happens centrally, separately from this
// module.
//
// `interruptSubmit` is the generated `-obelisk-ext` binding for the WIT
// `stub` interface's `interrupt: func() -> result<string, string>` (see
// wit/deps/obelisk-agent_stub/stub.wit). Naming follows the
// `<camelCase-fn>Submit` convention session.js already established for the
// same module's `injection`/`record-output` functions
// (`injectionSubmit`/`recordOutputSubmit`, both imported from
// "obelisk-agent:stub-obelisk-ext/stub").
import { interruptSubmit } from "obelisk-agent:stub-obelisk-ext/stub";
import { ScriptWatchGuard } from "./script-watch-logic.js";

const JOIN_SET_NAME = "script-watch";

export { ScriptWatchGuard };

// Submit the interrupt offer, plus the watchdog delay when `timeoutMs` is
// given (a number of milliseconds; `null`/`undefined` for "no timeout"),
// onto a fresh join set. PORT: script_watch.rs's `ScriptWatchGuard::arm`.
export function arm(timeoutMs) {
    const joinSet = obelisk.createJoinSet({ name: JOIN_SET_NAME });
    const offerExecutionId = interruptSubmit(joinSet);
    const watchdogDelayId = timeoutMs === null || timeoutMs === undefined
        ? null
        : joinSet.submitDelay({ milliseconds: timeoutMs });
    return new ScriptWatchGuard(joinSet, offerExecutionId, watchdogDelayId);
}
