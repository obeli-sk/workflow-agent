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
import { joinSetNameFor, ScriptWatchGuard } from "./script-watch-logic.js";

export { ScriptWatchGuard };

// Submit the interrupt offer, plus the watchdog delay when `timeoutMs` is
// given (a number of milliseconds; `null`/`undefined` for "no timeout"),
// onto a fresh join set named after `scriptId` (see `joinSetNameFor` in
// script-watch-logic.js for the naming/sanitization rules). PORT:
// script_watch.rs's `ScriptWatchGuard::arm` (Rust's
// `workflow_support::join_set_create()` makes a fresh *unnamed* join set per
// script; this runtime's `createJoinSet` requires a name, and a fixed one is
// rejected the second time a session runs a script - "Failed to create named
// join set: JoinSetCreateError::Conflict" - so each call needs a distinct
// name). `scriptId` is the caller's own shell/tool-call id (e.g.
// "shell-e2e-1", an LLM tool_use id), already unique per script execution by
// construction, so reusing it here needs no separate counter or other
// synthesized state.
export function arm(timeoutMs, scriptId) {
    const joinSet = obelisk.createJoinSet({ name: joinSetNameFor(scriptId) });
    const offerExecutionId = interruptSubmit(joinSet);
    const watchdogDelayId = timeoutMs === null || timeoutMs === undefined
        ? null
        : joinSet.submitDelay({ milliseconds: timeoutMs });
    return new ScriptWatchGuard(joinSet, offerExecutionId, watchdogDelayId);
}
