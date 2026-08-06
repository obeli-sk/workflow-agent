//! PORT: workflow/agent.js
//!
//! Public supervisor workflow. Resolves a pack descriptor (system prompt +
//! tool catalog), then delegates to the generic session loop
//! (`session::agent_loop_cancellable`, exported as
//! `obelisk-agent:workflow/workflow.agent-loop-cancellable`).
//!
//! Design choice (per the design doc): JS's `run` calls `agentLoopCancellable`
//! through an *imported* cross-function binding
//! (`import { agentLoopCancellable } from "obelisk-agent:workflow/workflow"`),
//! which the JS workflow runtime treats as a real child call so an operator
//! can cancel just the session (the `-cancellable` FFQN suffix) without
//! killing this supervisor. A bare Rust function call would forfeit that:
//! two ordinary function calls in the same component share one execution and
//! can't be cancelled independently. So this port reproduces the same
//! semantics explicitly: submit `agent-loop-cancellable` as a genuine child
//! execution (a one-off join set, since `run` submits exactly one child and
//! is done), then await it and translate a cancelled/failed child into an
//! error the same way `callErrorMessage` would.

use serde_json::{Value, json};

use crate::generated::obelisk::types::execution::ExecutionFailureKind;
use crate::generated::obelisk::workflow::workflow_support;
use crate::support::{decode_string_or_raw, split_ffqn};

const DEFAULT_DESCRIPTOR_FFQN: &str = "obelisk-control:agent/pack.describe";
const AGENT_LOOP_FFQN: &str = "obelisk-agent:workflow/workflow.agent-loop-cancellable";

pub fn run(
    prompt: String,
    model: Option<String>,
    descriptor_ffqn: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    // `model` selects an entry in the LLM catalog (AGENT_MODELS); empty =>
    // the catalog default. `effort` is a reasoning level (off/minimal/low/
    // medium/high/xhigh); empty => the provider default.
    let model_id = model.unwrap_or_default();
    let effort_level = effort.unwrap_or_default();
    let descriptor = descriptor_ffqn
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_DESCRIPTOR_FFQN.to_string());

    let execution_id = workflow_support::execution_id_current();

    let descriptor_function = split_ffqn(&descriptor)?;
    let described_json = match workflow_support::call_json(&descriptor_function, "[]") {
        Ok(Ok(value)) => value,
        Ok(Err(value)) => return Err(decode_string_or_raw(value.as_deref().unwrap_or("null"))),
        Err(err) => return Err(format!("{err:?}")),
    }
    .ok_or_else(|| format!("descriptor {descriptor} did not return {{ prompt }}"))?;
    let described: Value = serde_json::from_str(&described_json)
        .map_err(|e| format!("descriptor {descriptor} returned invalid JSON: {e}"))?;
    let system_prompt_base = described
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("descriptor {descriptor} did not return {{ prompt }}"))?;

    let system_prompt = format!(
        "{system_prompt_base}\n\n\
# This execution\n\n\
Your own workflow execution id is `{}`. Pass it to\n\
obelisk.get_execution / obelisk.get_logs to inspect your own run.",
        execution_id.id
    );

    // One-off join set: `run` submits exactly one child and awaits it once.
    let join_set = workflow_support::join_set_create();
    let agent_loop_function = split_ffqn(AGENT_LOOP_FFQN)?;
    let params = json!([prompt, system_prompt, model_id, effort_level]).to_string();
    let child_id = workflow_support::submit_json(&join_set, &agent_loop_function, &params)
        .map_err(|e| format!("{e:?}"))?;

    match workflow_support::join_next(&join_set) {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(Some(json))) => Err(decode_string_or_raw(&json)),
        Ok(Err(None)) => {
            let cancelled = matches!(
                workflow_support::get_execution_failure_kind(&child_id),
                Ok(Some(ExecutionFailureKind::Cancelled))
            );
            Err(if cancelled {
                "agent session cancelled".to_string()
            } else {
                "agent session failed".to_string()
            })
        }
        Err(e) => Err(format!("{e:?}")),
    }
}
