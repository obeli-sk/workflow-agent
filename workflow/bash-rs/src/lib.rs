//! Obelisk workflow component that runs a bash script through `just-bash-rs`.
//!
//! This is the end-to-end harness for the JS-to-Rust port: it proves the Rust
//! interpreter runs as a native `wasm32-unknown-unknown` workflow under Obelisk
//! (no Boa, no JS runtime). `run-bash` is pure and deterministic, which is what
//! the workflow runtime requires. The full durable session loop is layered on
//! top of this in a later phase.

use generated::export;
use generated::exports::just_bash::agent::bash::Guest;
use just_bash_rs::obelisk_pack::{self, ObeliskHost};
use just_bash_rs::{Bash, BashOptions, ExecOptions};

mod generated {
    #![allow(clippy::empty_line_after_outer_attr)]
    include!(concat!(env!("OUT_DIR"), "/any.rs"));
}

struct Component;
export!(Component with_types_in generated);

/// This throwaway proof-of-concept component has no real Obelisk host import
/// wired up yet (that's phase 5's `workflow/workflow-rs`, built against the
/// actual wit-bindgen `workflow-support.call-json` binding). Registering the
/// `obelisk` command here with a host that always errors is enough to prove
/// the custom-command mechanism plugs into a real wasm32 component and
/// dispatches without crashing.
struct UnavailableHost;

impl ObeliskHost for UnavailableHost {
    fn call_json(&mut self, _ffqn: &str, _params_json: &str) -> Result<Option<String>, String> {
        Err("obelisk host calls are not available in this proof-of-concept component".to_string())
    }
}

impl Guest for Component {
    fn run_bash(script: String, stdin: String) -> Result<String, String> {
        let mut bash = Bash::new(BashOptions {
            cwd: "/workspace".to_string(),
            ..Default::default()
        });
        bash.register_command(
            "obelisk",
            obelisk_pack::command_handler(Box::new(UnavailableHost)),
        );
        let result = bash.exec(&script, ExecOptions { stdin, cwd: None });
        let payload = serde_json::json!({
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.exit_code,
        });
        Ok(payload.to_string())
    }
}
