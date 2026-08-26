//! Host-installed abort watcher for one running bash script.
//!
//! The session loop arms a watcher around every script invocation (in
//! workflow-rs: a fresh join set holding an operator-interrupt offer stub and
//! an optional watchdog delay). The interpreter observes the signal only at
//! durable boundaries, after a custom command completes and inside `sleep`,
//! so nothing executing is ever killed mid-flight; whatever ran already stays
//! recorded in the output.

use std::cell::RefCell;
use std::rc::Rc;

/// Why a script stopped early. Exit codes follow the GNU conventions: 124 for
/// a timeout, 130 for an operator interrupt (SIGINT's exit status).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterruptKind {
    Timeout,
    Operator,
}

impl InterruptKind {
    pub fn exit_code(self) -> i32 {
        match self {
            InterruptKind::Timeout => 124,
            InterruptKind::Operator => 130,
        }
    }

    /// Marker recorded in `ExecResult::interrupted` and surfaced through the
    /// transcript.
    pub fn label(self) -> &'static str {
        match self {
            InterruptKind::Timeout => "timeout",
            InterruptKind::Operator => "operator",
        }
    }
}

/// Per-script abort seam, installed with `Bash::set_script_watch`.
pub trait ScriptWatch {
    /// Peek the signal at a durable boundary; `None` keeps running.
    fn poll(&mut self) -> Option<InterruptKind>;

    /// Durably wait `ms` milliseconds, aborting early when the signal lands.
    fn sleep(&mut self, ms: u64) -> Result<(), InterruptKind>;
}

/// Shared handle shape: `Bash` holds the watch across `exec` calls while the
/// session loop keeps the underlying join set alive until the script ends.
pub type SharedScriptWatch = Rc<RefCell<dyn ScriptWatch>>;
