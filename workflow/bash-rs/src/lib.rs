//! Obelisk workflow component that runs a bash script through `just-bash-rs`.
//!
//! This is the end-to-end harness for the JS-to-Rust port: it proves the Rust
//! interpreter runs as a native `wasm32-unknown-unknown` workflow under Obelisk
//! (no Boa, no JS runtime). `run-bash` is pure and deterministic, which is what
//! the workflow runtime requires. The full durable session loop is layered on
//! top of this in a later phase.

use generated::export;
use generated::exports::just_bash::agent::bash::Guest;
use just_bash_rs::{Bash, BashOptions, ExecOptions};

mod generated {
    #![allow(clippy::empty_line_after_outer_attr)]
    include!(concat!(env!("OUT_DIR"), "/any.rs"));
}

struct Component;
export!(Component with_types_in generated);

impl Guest for Component {
    fn run_bash(script: String, stdin: String) -> Result<String, String> {
        let mut bash = Bash::new(BashOptions {
            cwd: "/workspace".to_string(),
            ..Default::default()
        });
        let result = bash.exec(&script, ExecOptions { stdin, cwd: None });
        let payload = serde_json::json!({
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.exit_code,
        });
        Ok(payload.to_string())
    }
}
