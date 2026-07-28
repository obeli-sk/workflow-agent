//! PORT: vendor/just-bash/src/types.ts and src/limits.ts
//!
//! Public value types shared across the interpreter. These mirror the fields
//! the workflow reads today: `ExecResult` exposes stdout/stderr/exit-code and
//! the post-run environment so the session loop can track `PWD`.

use std::collections::BTreeMap;

/// Resource ceilings for a single `Bash` instance. The workflow disables the
/// wall-clock limit (durable sleeps are unbounded) but keeps byte limits.
#[derive(Debug, Clone)]
pub struct ExecutionLimits {
    /// `None` means unbounded (the workflow's `Number.POSITIVE_INFINITY`).
    pub max_execution_time_ms: Option<u64>,
    pub max_file_system_bytes: u64,
    pub max_output_size: u64,
    pub max_source_bytes: u64,
}

impl Default for ExecutionLimits {
    fn default() -> Self {
        Self {
            max_execution_time_ms: Some(30_000),
            max_file_system_bytes: 32 * 1024 * 1024,
            max_output_size: 1024 * 1024,
            max_source_bytes: 1024 * 1024,
        }
    }
}

/// Options passed once when constructing a `Bash`.
#[derive(Debug, Clone)]
pub struct BashOptions {
    pub cwd: String,
    pub defense_in_depth: bool,
    pub limits: ExecutionLimits,
    /// Returns the current wall-clock time as Unix epoch milliseconds, read on
    /// demand by `date` (not sampled per `exec`, so a `date` reflects the time
    /// it runs and does not cost a clock read on scripts that never call it).
    /// Defaults to a fixed clock (always epoch 0, i.e. 1970-01-01 UTC) since
    /// this interpreter has no host clock of its own and must stay
    /// deterministic for durable replay; the workflow overrides this with the
    /// durable Obelisk clock (a `sleep(now)` host activity, see `session.rs`).
    pub now_ms: fn() -> i64,
    /// Durably sleep for the given number of milliseconds, used by the `sleep`
    /// builtin. Defaults to a no-op (the bare interpreter and tests have no
    /// scheduler and must not block); the workflow overrides this with the
    /// durable Obelisk `sleep(in(...))` host activity (see `session.rs`).
    pub sleep_ms: fn(u64),
}

impl Default for BashOptions {
    fn default() -> Self {
        Self {
            cwd: "/workspace".to_string(),
            defense_in_depth: false,
            limits: ExecutionLimits::default(),
            now_ms: fixed_epoch,
            sleep_ms: no_sleep,
        }
    }
}

fn fixed_epoch() -> i64 {
    0
}

fn no_sleep(_ms: u64) {}

/// Per-`exec` inputs: the piped stdin and the working directory for this call.
#[derive(Debug, Clone, Default)]
pub struct ExecOptions {
    pub stdin: String,
    pub cwd: Option<String>,
}

/// Result of running a script.
#[derive(Debug, Clone, Default)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    /// Environment after the run; the session loop reads `PWD` to persist cwd.
    pub env: BTreeMap<String, String>,
}
