//! Small helpers shared by `session.rs`, `agent.rs`, and `host.rs`: FFQN
//! splitting into a WIT `function` record, and decoding a child execution's
//! JSON error payload into a plain message. This is the Rust equivalent of
//! JS's `callErrorMessage` / `obelisk.ChildExecutionError` unwrapping: here a
//! child's business error surfaces as `join-next`'s `Err(Some(json))` (or
//! `call-json`'s equivalent), not an exception, so there is nothing to catch
//! -- just a value to decode.

use serde_json::Value;

use crate::generated::obelisk::types::execution::Function;
use crate::generated::obelisk::workflow::workflow_support::{JoinSet, ResponseId};

/// Split `"namespace:pkg/iface.function"` into a WIT `function` record: the
/// interface name is everything before the last `.`, the function name is
/// what follows (matches upstream's own FFQN-splitting convention for
/// `submit`/`call`).
pub fn split_ffqn(ffqn: &str) -> Result<Function, String> {
    let (interface_name, function_name) = ffqn
        .rsplit_once('.')
        .ok_or_else(|| format!("invalid ffqn (missing '.'): {ffqn}"))?;
    Ok(Function {
        interface_name: interface_name.to_string(),
        function_name: function_name.to_string(),
    })
}

/// The execution id of a join set's last processed response, or `None` if it
/// was a delay (this session never submits delays to a join set) or nothing
/// has been processed yet. Rust equivalent of JS's `session.joinSet.lastId`.
pub fn last_response_execution_id(join_set: &JoinSet) -> Option<String> {
    match join_set.last_id() {
        Some(ResponseId::ExecutionId(id)) => Some(id.id),
        _ => None,
    }
}

/// Decode a child's business-error JSON payload (`Err(Some(json))` from
/// `join-next`/`call-json`) into a plain message: unwrap a JSON string,
/// otherwise render the JSON value as text. Mirrors JS's `e.value`, which the
/// host has already decoded to a native value by the time `callErrorMessage`
/// sees it. `None` (no payload -- a platform-level failure such as a timeout
/// or cancellation, or a bare `result<_, string>` err) falls back to a
/// generic message, mirroring `e.message`.
pub fn child_error_message(value: Option<String>) -> String {
    match value {
        Some(json) => decode_string_or_raw(&json),
        None => "child execution failed with no error payload".to_string(),
    }
}

/// Decode a raw JSON-text payload into a plain string: unwrap a JSON string,
/// otherwise render other JSON values as text, otherwise fall back to the raw
/// text unchanged (e.g. it wasn't valid JSON at all).
pub fn decode_string_or_raw(json: &str) -> String {
    match serde_json::from_str::<Value>(json) {
        Ok(Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => json.to_string(),
    }
}
