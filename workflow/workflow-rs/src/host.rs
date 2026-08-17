//! The real `ObeliskHost` implementation (deferred by phase 4's
//! `just_bash_rs::obelisk_pack`), wired to the actual
//! `obelisk:workflow/workflow-support@6.0.0.call-json` host import. Stateless:
//! every `obelisk` shell-command registration and the deployment-mount step
//! each construct their own `RealHost` value (mirrors JS's `obelisk.call`
//! being a global builtin usable from both places).

use just_bash_rs::obelisk_pack::ObeliskHost;

use crate::generated::obelisk::workflow::workflow_support;
use serde_json::Value;

use crate::session::Notifications;
use crate::support::{child_error_message, last_response_execution_id, split_ffqn};

const ASK_USER_FFQN: &str = "obelisk-agent:stub/stub.ask-user";
const NATIVE_CALL_FFQN: &str = "obelisk-control:tools/native.call";

pub struct RealHost {
    notifications: Notifications,
}

impl RealHost {
    pub fn new(notifications: Notifications) -> Self {
        Self { notifications }
    }

    fn ask_user(
        &self,
        function: &crate::generated::obelisk::types::execution::Function,
        params_json: &str,
    ) -> Result<Option<String>, String> {
        let question = serde_json::from_str::<Value>(params_json)
            .ok()
            .and_then(|value| value.as_array().and_then(|params| params.first()).cloned())
            .and_then(|value| value.as_str().map(str::to_string))
            .ok_or_else(|| "ask-user requires a question".to_string())?;
        let join_set = workflow_support::join_set_create();
        let execution_id = workflow_support::submit_json(&join_set, function, params_json)
            .map_err(|e| format!("ask-user submit failed: {e:?}"))?;
        self.notifications
            .human_input_requested(execution_id.id.clone(), question)?;
        let result = workflow_support::join_next(&join_set)
            .map_err(|e| format!("ask-user await failed: {e:?}"))?;
        let completed_id = last_response_execution_id(&join_set);
        if completed_id.as_deref() != Some(execution_id.id.as_str()) {
            return Err(format!("unexpected ask-user response: {completed_id:?}"));
        }
        self.notifications
            .human_input_resolved(execution_id.id.clone())?;
        match result {
            Ok(value) => Ok(value),
            Err(value) => Err(child_error_message(value)),
        }
    }

    fn native_ask_user(&self, params_json: &str) -> Option<Result<Option<String>, String>> {
        let params = serde_json::from_str::<Value>(params_json).ok()?;
        let params = params.as_array()?;
        if params.first().and_then(Value::as_str) != Some(ASK_USER_FFQN) {
            return None;
        }
        let target_params = match params.get(1).and_then(Value::as_str) {
            Some(value) => value,
            None => return Some(Err("native call requires params-json".to_string())),
        };
        let function = match split_ffqn(ASK_USER_FFQN) {
            Ok(function) => function,
            Err(error) => return Some(Err(error)),
        };
        let result = self.ask_user(&function, target_params).and_then(|raw| {
            let result = raw
                .map(|value| serde_json::from_str(&value).unwrap_or(Value::String(value)))
                .unwrap_or(Value::Null);
            let body = serde_json::json!({ "ffqn": ASK_USER_FFQN, "result": result }).to_string();
            serde_json::to_string(&body)
                .map(Some)
                .map_err(|error| format!("cannot encode native call result: {error}"))
        });
        Some(result)
    }
}

impl ObeliskHost for RealHost {
    fn call_json(&mut self, ffqn: &str, params_json: &str) -> Result<Option<String>, String> {
        let function = split_ffqn(ffqn)?;
        if ffqn == ASK_USER_FFQN {
            return self.ask_user(&function, params_json);
        }
        // The shell routes dynamic calls through native.call, so unwrap ask-user before that child blocks.
        if ffqn == NATIVE_CALL_FFQN
            && let Some(result) = self.native_ask_user(params_json)
        {
            return result;
        }
        match workflow_support::call_json(&function, params_json) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(value)) => Err(child_error_message(value)),
            Err(err) => Err(format!("{err:?}")),
        }
    }
}
