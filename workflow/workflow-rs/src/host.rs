//! The real host seams for `just_bash_rs`: `ObeliskHost` for functions chosen
//! at runtime (registry programs, MCP servers), reached over
//! `workflow-dynamic-support.call-json`, and `ControlPlane` for the pack's
//! fixed control-plane tools, reached through their link-checked WIT bindings.
//! Stateless apart from the notification channel ask-user reports through.

use just_bash_rs::obelisk_pack::{
    AttachedFile, CheckoutFile, CheckoutResult, ControlPlane, ExtensionKind, FunctionInfo,
    MissingFile, ObeliskHost, ParameterType, SubmitError,
};
use serde_json::Value;

use crate::generated::obelisk::workflow::{workflow_dynamic_support, workflow_support};
use crate::generated::obelisk_agent::stub_obelisk_ext::stub as stub_ext;
use crate::generated::obelisk_agent::tools::webapi;
use crate::generated::obelisk_control::tools::native;
use crate::session::Notifications;
use crate::support::{child_error_message, last_response_execution_id, split_ffqn};

const ASK_USER_FFQN: &str = "obelisk-agent:stub/stub.ask-user";

pub struct RealHost {
    notifications: Notifications,
}

impl RealHost {
    pub fn new(notifications: Notifications) -> Self {
        Self { notifications }
    }

    /// Answer `obelisk call obelisk-agent:stub/stub.ask-user` with a real
    /// question/answer exchange on this instance (the target has no such
    /// function); returns the answer's JSON text, like `native.call`.
    fn ask_user(&self, params_json: &str) -> Result<String, String> {
        let question = serde_json::from_str::<Value>(params_json)
            .ok()
            .and_then(|value| value.as_array().and_then(|params| params.first()).cloned())
            .and_then(|value| value.as_str().map(str::to_string))
            .ok_or_else(|| "ask-user requires a question".to_string())?;
        let join_set = workflow_support::join_set_create();
        let execution_id = stub_ext::ask_user_submit(&join_set, &question)
            .map_err(|e| format!("ask-user submit failed: {e:?}"))?;
        self.notifications
            .human_input_requested(execution_id.id.clone(), question)?;
        self.notifications.flush()?;
        let result = workflow_support::join_next(&join_set)
            .map_err(|e| format!("ask-user await failed: {e:?}"))?;
        let completed_id = last_response_execution_id(&join_set);
        if completed_id.as_deref() != Some(execution_id.id.as_str()) {
            return Err(format!("unexpected ask-user response: {completed_id:?}"));
        }
        self.notifications
            .human_input_resolved(execution_id.id.clone())?;
        match result {
            Ok(value) => Ok(value.unwrap_or_else(|| "null".to_string())),
            Err(value) => Err(child_error_message(value)),
        }
    }
}

impl ObeliskHost for RealHost {
    fn call_json(&mut self, ffqn: &str, params_json: &str) -> Result<Option<String>, String> {
        let function = split_ffqn(ffqn)?;
        match workflow_dynamic_support::call_json(&function, params_json) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(value)) => Err(child_error_message(value)),
            Err(err) => Err(format!("{err:?}")),
        }
    }
}

impl ControlPlane for RealHost {
    fn list_functions(
        &mut self,
        ffqn_prefix: &str,
        length: u32,
    ) -> Result<Vec<FunctionInfo>, String> {
        let functions = webapi::list_functions(ffqn_prefix, length).map_err(tool_error)?;
        Ok(functions.into_iter().map(function_info).collect())
    }

    fn get_function_wit(&mut self, ffqn: &str) -> Result<String, String> {
        webapi::get_function_wit(ffqn)
    }

    fn list_executions(
        &mut self,
        ffqn_prefix: &str,
        execution_id_prefix: &str,
        show_derived: bool,
        hide_finished: bool,
        length: u32,
    ) -> Result<String, String> {
        webapi::list_executions(
            ffqn_prefix,
            execution_id_prefix,
            show_derived,
            hide_finished,
            "",
            "",
            "",
            "",
            false,
            length,
        )
    }

    fn get_execution(&mut self, execution_id: &str) -> Result<String, String> {
        webapi::get_execution(execution_id)
    }

    fn get_logs(&mut self, execution_id: &str, length: u32) -> Result<String, String> {
        webapi::get_logs(
            execution_id,
            true,
            true,
            true,
            &[],
            &[],
            "",
            "",
            false,
            length,
        )
    }

    fn get_result_json(&mut self, execution_id: &str) -> Result<String, String> {
        webapi::get_result_json(execution_id)
    }

    fn list_deployments(&mut self, length: u32) -> Result<String, String> {
        webapi::list_deployments("", false, length)
    }

    fn get_deployment(&mut self, deployment_id: &str) -> Result<String, String> {
        webapi::get_deployment(deployment_id, None, None, None, None)
    }

    fn current_deployment_id(&mut self) -> Result<String, String> {
        webapi::current_deployment_id()
    }

    fn get_app_config(&mut self) -> Result<Option<String>, String> {
        webapi::get_app_config()
    }

    fn deployment_checkout(&mut self, deployment_id: &str) -> Result<CheckoutResult, String> {
        let checkout = webapi::deployment_checkout(deployment_id).map_err(tool_error)?;
        Ok(CheckoutResult {
            deployment_toml: checkout.deployment_toml,
            files: checkout
                .files
                .into_iter()
                .map(|file| CheckoutFile {
                    path: file.path,
                    digest: file.digest,
                    size: file.size,
                })
                .collect(),
        })
    }

    fn deployment_read_blob(&mut self, digest: &str) -> Result<String, String> {
        webapi::deployment_read_blob(digest)
    }

    fn deployment_submit(
        &mut self,
        deployment_toml: &str,
        attachments: &[AttachedFile],
        description: &str,
        allow_missing_runtime_config: bool,
        deployment_id: &str,
    ) -> Result<String, SubmitError> {
        let attachments: Vec<_> = attachments
            .iter()
            .map(|file| webapi::AttachedFile {
                path: file.path.clone(),
                digest: file.digest.clone(),
                content: file.content.clone(),
            })
            .collect();
        webapi::deployment_submit(
            deployment_toml,
            &attachments,
            description,
            allow_missing_runtime_config,
            deployment_id,
        )
        .map_err(|error| match error {
            webapi::SubmitError::PermanentMissingFiles(files) => SubmitError::MissingFiles(
                files
                    .into_iter()
                    .map(|file| MissingFile {
                        path: file.path,
                        digest: file.digest,
                    })
                    .collect(),
            ),
            webapi::SubmitError::PermanentError(message)
            | webapi::SubmitError::TransientError(message) => SubmitError::Failed(message),
            webapi::SubmitError::ExecutionFailed => {
                SubmitError::Failed(EXECUTION_FAILED.to_string())
            }
        })
    }

    fn deployment_switch(
        &mut self,
        deployment_id: &str,
        allow_missing_runtime_config: bool,
    ) -> Result<String, String> {
        webapi::deployment_switch(deployment_id, allow_missing_runtime_config)
    }

    fn apply_deployment(&mut self, deployment_id: &str) -> Result<String, String> {
        webapi::apply_deployment(deployment_id)
    }

    fn native_call(&mut self, ffqn: &str, params_json: &str) -> Result<String, String> {
        if ffqn == ASK_USER_FFQN {
            return self.ask_user(params_json);
        }
        native::call(ffqn, params_json)
    }
}

/// How Obelisk spells a platform failure projected into a string error arm.
const EXECUTION_FAILED: &str = "execution_failed";

fn tool_error(error: webapi::ToolError) -> String {
    match error {
        webapi::ToolError::PermanentError(message) | webapi::ToolError::TransientError(message) => {
            message
        }
        webapi::ToolError::ExecutionFailed => EXECUTION_FAILED.to_string(),
    }
}

fn function_info(function: webapi::FunctionInfo) -> FunctionInfo {
    FunctionInfo {
        ffqn: function.ffqn,
        parameter_types: function
            .parameter_types
            .into_iter()
            .map(|parameter| ParameterType {
                name: parameter.name,
                wit_type: parameter.wit_type,
            })
            .collect(),
        return_type: function.return_type,
        extension: function.extension.map(|extension| match extension {
            webapi::ExtensionKind::Submit => ExtensionKind::Submit,
            webapi::ExtensionKind::AwaitNext => ExtensionKind::AwaitNext,
            webapi::ExtensionKind::Schedule => ExtensionKind::Schedule,
            webapi::ExtensionKind::Stub => ExtensionKind::Stub,
            webapi::ExtensionKind::Get => ExtensionKind::Get,
        }),
        wit: function.wit,
    }
}
