//! Command adapter for Obelisk-backed shell programs with this contract:
//!
//! `func(stdin: string, args: list<string>) -> result<record {
//!     stdout: string, stderr: string, exit-code: u32
//! }, string>`

use serde_json::{Value, json};

use crate::custom_command::CustomCommandHandler;
use crate::interpreter::CommandOutput;
use crate::obelisk_pack::ObeliskHost;

/// Adapt one program function to just-bash's custom-command shape.
pub fn command_handler(
    command_name: impl Into<String>,
    ffqn: impl Into<String>,
    host: Box<dyn ObeliskHost>,
) -> CustomCommandHandler {
    let command_name = command_name.into();
    let ffqn = ffqn.into();
    let mut host = host;
    Box::new(move |_interp, args, stdin| {
        execute_program(&command_name, &ffqn, args, &stdin, host.as_mut())
    })
}

fn execute_program(
    command_name: &str,
    ffqn: &str,
    args: &[String],
    stdin: &str,
    host: &mut dyn ObeliskHost,
) -> CommandOutput {
    let params = json!([stdin, args]).to_string();
    match host.call_json(ffqn, &params) {
        Ok(Some(raw)) => decode_output(command_name, &raw),
        Ok(None) => failure(command_name, "program returned no output"),
        Err(error) => failure(command_name, &error),
    }
}

fn decode_output(command_name: &str, raw: &str) -> CommandOutput {
    let value: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(error) => {
            return failure(
                command_name,
                &format!("program returned invalid JSON: {error}"),
            );
        }
    };
    let Some(output) = value.as_object() else {
        return failure(command_name, "program output was not a record");
    };
    let Some(stdout) = output.get("stdout").and_then(Value::as_str) else {
        return failure(command_name, "program output has no stdout");
    };
    let Some(stderr) = output.get("stderr").and_then(Value::as_str) else {
        return failure(command_name, "program output has no stderr");
    };
    let Some(exit_code) = output.get("exit_code").and_then(Value::as_u64) else {
        return failure(command_name, "program output has no exit_code");
    };
    CommandOutput {
        stdout: stdout.to_string(),
        stderr: stderr.to_string(),
        exit_code: i32::try_from(exit_code).unwrap_or(i32::MAX),
    }
}

fn failure(command_name: &str, message: &str) -> CommandOutput {
    CommandOutput {
        stdout: String::new(),
        stderr: format!("{command_name}: {message}\n"),
        exit_code: 1,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    struct FakeHost {
        responses: BTreeMap<String, Result<Option<String>, String>>,
        calls: Vec<(String, String)>,
    }

    impl FakeHost {
        fn with(ffqn: &str, response: &str) -> Self {
            Self {
                responses: BTreeMap::from([(ffqn.to_string(), Ok(Some(response.to_string())))]),
                calls: Vec::new(),
            }
        }
    }

    impl ObeliskHost for FakeHost {
        fn call_json(&mut self, ffqn: &str, params_json: &str) -> Result<Option<String>, String> {
            self.calls.push((ffqn.to_string(), params_json.to_string()));
            self.responses
                .remove(ffqn)
                .unwrap_or_else(|| Err(format!("no fixture for {ffqn}")))
        }
    }

    #[test]
    fn program_adapter_forwards_stdin_and_argv() {
        let mut host = FakeHost::with(
            "obelisk-agent:programs/program.curl",
            r#"{"stdout":"body\n","stderr":"","exit_code":0}"#,
        );
        let output = execute_program(
            "curl",
            "obelisk-agent:programs/program.curl",
            &["-s".to_string(), "https://obeli.sk".to_string()],
            "input",
            &mut host,
        );

        assert_eq!(output.stdout, "body\n");
        assert_eq!(output.stderr, "");
        assert_eq!(output.exit_code, 0);
        assert_eq!(host.calls[0].1, r#"["input",["-s","https://obeli.sk"]]"#);
    }

    #[test]
    fn malformed_program_output_is_a_normal_command_failure() {
        let mut host = FakeHost::with(
            "obelisk-agent:programs/program.curl",
            r#"{"stdout":"body"}"#,
        );
        let output = execute_program(
            "curl",
            "obelisk-agent:programs/program.curl",
            &[],
            "",
            &mut host,
        );

        assert_eq!(output.exit_code, 1);
        assert_eq!(output.stderr, "curl: program output has no stderr\n");
    }
}
