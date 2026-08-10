//! Discovery and command adapters for Obelisk-backed shell programs.
//!
//! Every exported function under [`PROGRAM_INTERFACE_PREFIX`] is eligible to
//! become a just-bash command when its WIT matches the program contract:
//!
//! `func(stdin: string, args: list<string>) -> result<record {
//!     stdout: string, stderr: string, exit-code: u32
//! }, string>`

use serde_json::{Value, json};

use crate::custom_command::CustomCommandHandler;
use crate::interpreter::CommandOutput;
use crate::obelisk_pack::ObeliskHost;

pub const PROGRAM_INTERFACE_PREFIX: &str = "obelisk-agent:programs/program.";
pub const LIST_FUNCTIONS_FFQN: &str = "obelisk-agent:tools/webapi.list-functions";
const MAX_PROGRAMS: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    pub name: String,
    pub ffqn: String,
}

/// Find deployed functions in the program interface and retain only functions
/// with the uniform shell-program WIT signature.
pub fn discover(host: &mut dyn ObeliskHost) -> Result<Vec<Program>, String> {
    let params = json!([PROGRAM_INTERFACE_PREFIX, MAX_PROGRAMS]).to_string();
    let raw = host
        .call_json(LIST_FUNCTIONS_FFQN, &params)?
        .ok_or_else(|| "program discovery returned no body".to_string())?;
    let outer: Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid program discovery JSON: {e}"))?;
    let functions = match outer {
        // backcompat: 0.1.0 list-functions returned its array as a JSON string.
        Value::String(inner) => serde_json::from_str::<Value>(&inner)
            .map_err(|e| format!("invalid program list JSON: {e}"))?,
        other => other,
    };
    let functions = functions
        .as_array()
        .ok_or_else(|| "program discovery did not return an array".to_string())?;

    let mut programs = Vec::new();
    for function in functions {
        let Some(ffqn) = function.get("ffqn").and_then(Value::as_str) else {
            continue;
        };
        let Some(name) = ffqn.strip_prefix(PROGRAM_INTERFACE_PREFIX) else {
            continue;
        };
        let Some(wit) = function.get("wit").and_then(Value::as_str) else {
            continue;
        };
        if valid_program_name(name) && has_program_signature(name, wit) {
            programs.push(Program {
                name: name.to_string(),
                ffqn: ffqn.to_string(),
            });
        }
    }
    programs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(programs)
}

/// Adapt one discovered program function to just-bash's custom-command shape.
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

fn valid_program_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn has_program_signature(name: &str, wit: &str) -> bool {
    let compact: String = wit.chars().filter(|c| !c.is_whitespace()).collect();
    let compact = compact.replace(",}", "}");
    let prefix = format!("{name}:func(stdin:string,args:list<string>)->");
    let Some(result) = compact
        .split_once(&prefix)
        .map(|(_, tail)| tail.split(';').next().unwrap_or(""))
    else {
        return false;
    };
    let fields = "{stdout:string,stderr:string,exit-code:u32}";
    if !result.starts_with("result<") || !result.ends_with(",string>") {
        return false;
    }
    let ok_type = &result[7..result.len() - 8];
    ok_type == format!("record{fields}")
        || (valid_program_name(ok_type) && compact.contains(&format!("record{ok_type}{fields}")))
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
    fn discovers_only_matching_program_exports() {
        let functions = json!([
            {
                "ffqn": "obelisk-agent:programs/program.curl",
                "wit": "package obelisk-agent:programs;\ninterface program {\n  record t0 { stdout: string, stderr: string, exit-code: u32, }\n  curl: func(stdin: string, args: list<string>) -> result<t0, string>;\n}"
            },
            {
                "ffqn": "obelisk-agent:programs/program.bad",
                "wit": "interface program { bad: func(args: list<string>) -> string; }"
            },
            {
                "ffqn": "elsewhere:programs/program.other",
                "wit": "interface program { other: func(stdin: string, args: list<string>) -> record { stdout: string, stderr: string, exit-code: u32 }; }"
            }
        ]);
        let response = serde_json::to_string(&functions.to_string()).unwrap();
        let mut host = FakeHost::with(LIST_FUNCTIONS_FFQN, &response);

        assert_eq!(
            discover(&mut host).unwrap(),
            vec![Program {
                name: "curl".to_string(),
                ffqn: "obelisk-agent:programs/program.curl".to_string(),
            }]
        );
        assert_eq!(
            host.calls,
            vec![(
                LIST_FUNCTIONS_FFQN.to_string(),
                "[\"obelisk-agent:programs/program.\",100]".to_string(),
            )]
        );
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
