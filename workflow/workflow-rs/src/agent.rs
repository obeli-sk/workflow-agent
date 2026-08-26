//! PORT: workflow/agent.js
//!
//! Public workflow. Resolves a system-prompt descriptor, then runs the generic
//! session loop in the same execution.

use serde_json::Value;

use crate::generated::obelisk::workflow::workflow_support;
use crate::support::{decode_string_or_raw, split_ffqn};

const DEFAULT_DESCRIPTOR_FFQN: &str = "obelisk-control:agent/pack.describe";

pub fn run(
    prompt: String,
    model: Option<String>,
    descriptor_ffqn: Option<String>,
    effort: Option<String>,
    name: Option<String>,
) -> Result<(), String> {
    // `model` selects an entry in the LLM catalog (AGENT_MODELS); empty =>
    // the catalog default. `effort` is a reasoning level (off/minimal/low/
    // medium/high/xhigh); empty => the provider default. `name` is a slug
    // label for the session (set by `chat create --name`); empty => unnamed.
    let model_id = model.unwrap_or_default();
    let effort_level = effort.unwrap_or_default();
    let session_name = name.unwrap_or_default();
    let descriptor = descriptor_ffqn
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_DESCRIPTOR_FFQN.to_string());

    let descriptor_function = split_ffqn(&descriptor)?;
    let described_json = match workflow_support::call_json(&descriptor_function, "[]") {
        Ok(Ok(value)) => value,
        Ok(Err(value)) => return Err(decode_string_or_raw(value.as_deref().unwrap_or("null"))),
        Err(err) => return Err(format!("{err:?}")),
    }
    .ok_or_else(|| format!("descriptor {descriptor} did not return {{ prompt }}"))?;
    let described: Value = serde_json::from_str(&described_json)
        .map_err(|e| format!("descriptor {descriptor} returned invalid JSON: {e}"))?;
    let system_prompt = described
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("descriptor {descriptor} did not return {{ prompt }}"))?;
    // Degraded session-start fetches (docs indexes and the like) come back as
    // warnings; the loop surfaces them to the user in the UI transcript.
    let descriptor_warnings: Vec<String> = described
        .get("warnings")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();

    crate::session::agent_loop(
        prompt,
        system_prompt.to_string(),
        model_id,
        effort_level,
        descriptor_warnings,
        session_name,
    )
}
