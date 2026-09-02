// PORT: vendor/just-bash-rs/src/watch.rs
//
// Host-installed abort watcher for one running bash script. The session loop
// arms a watcher around every script invocation (in workflow-js: a fresh
// join set holding an operator-interrupt offer stub and an optional
// watchdog delay -- see workflow/workflow-js/src/script-watch.js). The
// interpreter observes the signal only at durable boundaries, after a
// custom command completes and inside `sleep`, so nothing executing is ever
// killed mid-command; whatever ran already stays recorded in the output.
//
// Rust's `ScriptWatch` is a trait with a `poll`/`sleep` pair and a separate
// `InterruptKind` enum; JS has no enum, so the "kind" is just one of the two
// string constants below. Those strings double as `ExecResult.interrupted`
// and the WIT-level `shell-result.interrupted` field, so no further mapping
// is needed crossing that boundary.
//
// Duck-typed "ScriptWatch" contract, installed with `Bash#setScriptWatch`:
//
//   {
//     // Peek the signal; never blocks. Returns TIMEOUT / OPERATOR / null
//     // ("keep running"). Called once after every *custom* command
//     // completes (never after a builtin: builtins are pure/instant,
//     // custom commands are the ones that reach a host/network, which is
//     // where sitting in a tight loop needs to become interruptible).
//     poll() { ... },
//
//     // Durably wait `ms` milliseconds, waking early when the signal
//     // lands. Returns `{ interrupted: TIMEOUT | OPERATOR | null }` rather
//     // than throwing, mirroring Rust's `Result<(), InterruptKind>` --
//     // the `sleep` builtin decides what to do with it (see
//     // commands/timeutil.js).
//     sleep(ms) { ... },
//   }

export const TIMEOUT = "timeout";
export const OPERATOR = "operator";

// Exit codes follow the GNU conventions: 124 for a timeout, 130 for an
// operator interrupt (SIGINT's exit status).
export function exitCodeForInterrupt(kind) {
    switch (kind) {
        case TIMEOUT: return 124;
        case OPERATOR: return 130;
        default: throw new Error(`unknown interrupt kind: ${kind}`);
    }
}
