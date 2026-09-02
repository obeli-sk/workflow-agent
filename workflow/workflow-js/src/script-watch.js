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

export { ScriptWatchGuard };

// Submit the interrupt offer, plus the watchdog delay when `timeoutMs` is
// given (a number of milliseconds; `null`/`undefined` for "no timeout"),
// onto a fresh anonymous join set. PORT: script_watch.rs's
// `ScriptWatchGuard::arm`, which uses Rust's `workflow_support::
// join_set_create()` (unnamed). `obelisk.createJoinSet()` with no `name`
// makes the same kind of unnamed, ordinal-numbered join set (confirmed
// against obelisk's workflow-js-runtime tests), matching Rust's replay
// history exactly - a *named* join set here (an earlier version of this
// file used one keyed by the calling script id, to sidestep
// `JoinSetCreateError::Conflict` on a second same-named call) diverges from
// Rust's anonymous one and fails cross-backend replay with a
// NonDeterminismError (see scripts/test-e2e-replay-parity.sh). Anonymous
// join sets have no such conflict to sidestep in the first place: each call
// gets its own ordinal, unique by construction.
export function arm(timeoutMs) {
    const joinSet = obelisk.createJoinSet();
    const offerExecutionId = interruptSubmit(joinSet);
    const watchdogDelayId = timeoutMs === null || timeoutMs === undefined
        ? null
        : joinSet.submitDelay({ milliseconds: timeoutMs });
    return new ScriptWatchGuard(joinSet, offerExecutionId, watchdogDelayId);
}
