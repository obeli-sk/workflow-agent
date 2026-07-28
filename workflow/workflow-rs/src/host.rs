//! The real `ObeliskHost` implementation (deferred by phase 4's
//! `just_bash_rs::obelisk_pack`), wired to the actual
//! `obelisk:workflow/workflow-support@6.0.0.call-json` host import. Stateless:
//! every `obelisk` shell-command registration and the deployment-mount step
//! each construct their own `RealHost` value (mirrors JS's `obelisk.call`
//! being a global builtin usable from both places).

use just_bash_rs::obelisk_pack::ObeliskHost;

use crate::generated::obelisk::workflow::workflow_support;
use crate::support::{child_error_message, split_ffqn};

pub struct RealHost;

impl ObeliskHost for RealHost {
    fn call_json(&mut self, ffqn: &str, params_json: &str) -> Result<Option<String>, String> {
        let function = split_ffqn(ffqn)?;
        match workflow_support::call_json(&function, params_json) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(value)) => Err(child_error_message(value)),
            Err(err) => Err(format!("{err:?}")),
        }
    }
}
