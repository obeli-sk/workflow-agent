//! Native Rust Obelisk workflow: the workflow-agent session engine (phase 5
//! of the JS-to-Rust port; see meta/designs/workflow-agent-rust-port.md).
//!
//! Ports `workflow/agent-loop-src.js` (`session.rs`) and `workflow/agent.js`
//! (`agent.rs`), running the Rust `just-bash-rs` interpreter (`vendor/
//! just-bash-rs`) as the model-facing `bash` tool instead of Boa + the JS
//! `just-bash` package.

mod agent;
mod host;
mod session;
mod support;

mod generated {
    #![allow(clippy::empty_line_after_outer_attr)]
    include!(concat!(env!("OUT_DIR"), "/any.rs"));
}

use generated::export;
use generated::exports::obelisk_agent::workflow::workflow::Guest;

struct Component;
export!(Component with_types_in generated);

impl Guest for Component {
    fn run_cancellable(
        prompt: String,
        model: Option<String>,
        descriptor_ffqn: Option<String>,
        effort: Option<String>,
    ) -> Result<(), String> {
        agent::run(prompt, model, descriptor_ffqn, effort)
    }
}
