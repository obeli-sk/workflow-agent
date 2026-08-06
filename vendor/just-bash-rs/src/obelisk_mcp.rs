//! Discovery and command adapters for stateless MCP servers.
//!
//! Each configured MCP server is one deployed activity under
//! [`SERVER_INTERFACE_PREFIX`] whose WIT is the uniform stateless-transport
//! contract:
//!
//! `func(method: string, params-json: string) -> result<string, string>`
//!
//! The function name is the operator-chosen server name. The session registers
//! one just-bash command per server (`<server> tools|call|prompts|prompt|info`)
//! plus a global `mcp` registry command. Every live MCP request bottoms out in
//! one `ObeliskHost::call_json` to the server's activity, which performs the
//! JSON-RPC-over-HTTP POST (`activity/mcp.js`); this module only translates
//! shell subcommands into `(method, params-json)` and renders the result.
//!
//! See `apps/workflow-agent/docs/mcp.md` for the design.

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Value, json};

use crate::custom_command::CustomCommandHandler;
use crate::interpreter::CommandOutput;
use crate::obelisk_pack::ObeliskHost;

pub const SERVER_INTERFACE_PREFIX: &str = "obelisk-agent:mcp/server.";
pub const LIST_FUNCTIONS_FFQN: &str = "obelisk-agent:tools/webapi.list-functions";
const MAX_SERVERS: u32 = 100;

/// Pseudo-method served inline by the transport activity (no HTTP): reports the
/// configured endpoint URL and whether a bearer token is set, so `mcp list` can
/// describe each server without reaching the network.
const CONFIG_METHOD: &str = "client/config";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Server {
    pub name: String,
    pub ffqn: String,
}

/// The shared, mutable set of registered servers backing the global `mcp`
/// command. The session updates it as deployments change; the `mcp` handler
/// reads it at call time.
pub type ServerRegistry = Rc<RefCell<Vec<Server>>>;

/// Find deployed functions in the MCP server interface and keep only those with
/// the uniform stateless-transport WIT signature.
pub fn discover(host: &mut dyn ObeliskHost) -> Result<Vec<Server>, String> {
    let params = json!([SERVER_INTERFACE_PREFIX, MAX_SERVERS]).to_string();
    let raw = host
        .call_json(LIST_FUNCTIONS_FFQN, &params)?
        .ok_or_else(|| "mcp server discovery returned no body".to_string())?;
    let outer: Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid mcp discovery JSON: {e}"))?;
    let functions = match outer {
        Value::String(inner) => serde_json::from_str::<Value>(&inner)
            .map_err(|e| format!("invalid mcp server list JSON: {e}"))?,
        other => other,
    };
    let functions = functions
        .as_array()
        .ok_or_else(|| "mcp discovery did not return an array".to_string())?;

    let mut servers = Vec::new();
    for function in functions {
        let Some(ffqn) = function.get("ffqn").and_then(Value::as_str) else {
            continue;
        };
        let Some(name) = ffqn.strip_prefix(SERVER_INTERFACE_PREFIX) else {
            continue;
        };
        let Some(wit) = function.get("wit").and_then(Value::as_str) else {
            continue;
        };
        if valid_server_name(name) && has_server_signature(name, wit) {
            servers.push(Server {
                name: name.to_string(),
                ffqn: ffqn.to_string(),
            });
        }
    }
    servers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(servers)
}

/// Adapt one discovered server to a just-bash command:
/// `<server> tools|call|prompts|prompt|info`.
pub fn server_command_handler(
    server: impl Into<String>,
    ffqn: impl Into<String>,
    host: Box<dyn ObeliskHost>,
) -> CustomCommandHandler {
    let server = server.into();
    let ffqn = ffqn.into();
    let mut host = host;
    Box::new(move |_interp, args, stdin| {
        match run_server(&server, &ffqn, args, &stdin, host.as_mut()) {
            Ok(output) => output,
            Err(message) => fail(format!("{server}: {message}\n")),
        }
    })
}

/// Build the global `mcp` registry command: `mcp`/`mcp list` describes every
/// registered server, `mcp tools` fans `tools/list` across all of them.
pub fn registry_command_handler(
    registry: ServerRegistry,
    host: Box<dyn ObeliskHost>,
) -> CustomCommandHandler {
    let mut host = host;
    Box::new(
        move |_interp, args, _stdin| match run_registry(&registry, args, host.as_mut()) {
            Ok(output) => output,
            Err(message) => fail(format!("mcp: {message}\n")),
        },
    )
}

fn run_server(
    server: &str,
    ffqn: &str,
    args: &[String],
    stdin: &str,
    host: &mut dyn ObeliskHost,
) -> Result<CommandOutput, String> {
    let sub = args.first().map(String::as_str).unwrap_or("");
    let rest: &[String] = if args.len() > 1 { &args[1..] } else { &[] };
    match sub {
        "" | "--help" | "help" => Ok(ok(server_help(server))),
        "tools" => {
            let result = rpc(host, ffqn, "tools/list", json!({}))?;
            Ok(ok(pretty_list(&result, "tools")))
        }
        "call" => {
            let tool = required(rest.first().map(String::as_str), "tool name")?;
            let arguments = tool_arguments(rest.get(1).map(String::as_str), stdin)?;
            let result = rpc(
                host,
                ffqn,
                "tools/call",
                json!({"name": tool, "arguments": arguments}),
            )?;
            Ok(render_tool_result(&result))
        }
        "prompts" => {
            let result = rpc(host, ffqn, "prompts/list", json!({}))?;
            Ok(ok(pretty_list(&result, "prompts")))
        }
        "prompt" => {
            let name = required(rest.first().map(String::as_str), "prompt name")?;
            let arguments = prompt_arguments(&rest[1..])?;
            let result = rpc(
                host,
                ffqn,
                "prompts/get",
                json!({"name": name, "arguments": arguments}),
            )?;
            Ok(ok(render_prompt(&result)))
        }
        "info" => {
            let result = rpc(host, ffqn, "server/discover", json!({}))?;
            Ok(ok(ensure_newline(pretty(&result))))
        }
        other => Ok(fail(format!(
            "{server}: unknown subcommand '{other}'\n{}",
            server_help(server)
        ))),
    }
}

fn run_registry(
    registry: &ServerRegistry,
    args: &[String],
    host: &mut dyn ObeliskHost,
) -> Result<CommandOutput, String> {
    let action = args.first().map(String::as_str).unwrap_or("");
    let servers = registry.borrow().clone();
    match action {
        "" | "list" => {
            if servers.is_empty() {
                return Ok(ok("No MCP servers are configured.\n".to_string()));
            }
            let mut out = String::new();
            for server in &servers {
                // `client/config` is served inline by the transport (no HTTP), so
                // listing never reaches the network even when a server is down.
                let (url, auth) = match rpc(host, &server.ffqn, CONFIG_METHOD, json!({})) {
                    Ok(cfg) => (
                        cfg.get("url")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        cfg.get("auth").and_then(Value::as_bool).unwrap_or(false),
                    ),
                    Err(_) => (String::new(), false),
                };
                let url = if url.is_empty() {
                    "<unset>".to_string()
                } else {
                    url
                };
                out.push_str(&format!(
                    "{}  url={}  auth={}\n",
                    server.name,
                    url,
                    if auth { "yes" } else { "no" }
                ));
            }
            Ok(ok(out))
        }
        "tools" => {
            let mut out = String::new();
            for server in &servers {
                out.push_str(&format!("## {}\n", server.name));
                match rpc(host, &server.ffqn, "tools/list", json!({})) {
                    Ok(result) => out.push_str(&pretty_list(&result, "tools")),
                    Err(err) => out.push_str(&format!("error: {err}\n")),
                }
            }
            if out.is_empty() {
                out.push_str("No MCP servers are configured.\n");
            }
            Ok(ok(out))
        }
        other => Ok(fail(format!(
            "mcp: unknown subcommand '{other}'\n{}",
            registry_help()
        ))),
    }
}

/// One MCP call: hand `(method, params-json)` to the server's transport activity
/// and peel the JSON-RPC `result` back out. The activity's ok arm is a JSON
/// string (the stringified result); `call_json` returns that string's JSON text,
/// so it arrives quoted and is parsed once more here.
fn rpc(
    host: &mut dyn ObeliskHost,
    ffqn: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let args = json!([method, params.to_string()]).to_string();
    match host.call_json(ffqn, &args)? {
        Some(raw) => {
            let outer: Value = serde_json::from_str(&raw)
                .map_err(|e| format!("invalid mcp response JSON: {e}"))?;
            match outer {
                Value::String(inner) => serde_json::from_str(&inner)
                    .map_err(|e| format!("invalid mcp result JSON: {e}")),
                other => Ok(other),
            }
        }
        None => Ok(Value::Null),
    }
}

/// A `tools/list` / `prompts/list` result: print the named array pretty when
/// present, otherwise the whole result.
fn pretty_list(result: &Value, key: &str) -> String {
    match result.get(key) {
        Some(list) => ensure_newline(pretty(list)),
        None => ensure_newline(pretty(result)),
    }
}

/// A `tools/call` result (MCP `CallToolResult`): concatenate its text content to
/// stdout; an `isError` result goes to stderr with a non-zero exit. Non-text
/// content falls back to the raw JSON.
fn render_tool_result(result: &Value) -> CommandOutput {
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let text = content_text(result.get("content"));
    let body = if text.is_empty() {
        ensure_newline(pretty(result))
    } else {
        ensure_newline(text)
    };
    if is_error { fail(body) } else { ok(body) }
}

/// A `prompts/get` result (MCP `GetPromptResult`): render each message as
/// `[role] text` to stdout. Prompts are user-initiated templates, surfaced for
/// the user (or model) to paste into the conversation.
fn render_prompt(result: &Value) -> String {
    let Some(messages) = result.get("messages").and_then(Value::as_array) else {
        return ensure_newline(pretty(result));
    };
    let mut out = String::new();
    if let Some(desc) = result.get("description").and_then(Value::as_str)
        && !desc.is_empty()
    {
        out.push_str(&format!("# {desc}\n\n"));
    }
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let text = content_text(message.get("content"));
        out.push_str(&format!("[{role}] {text}\n"));
    }
    out
}

/// Extract concatenated `text` from an MCP content value, which is either a
/// single content object or an array of them (`{ type: "text", text }`).
fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        Some(Value::Object(_)) => content
            .and_then(|c| c.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

/// `<server> call <tool> <json-args>`: explicit JSON positional, else stdin,
/// else an empty object. A present-but-empty positional is a shell expansion
/// that produced nothing (mirrors the `obelisk call` guard).
fn tool_arguments(arg: Option<&str>, stdin: &str) -> Result<Value, String> {
    if matches!(arg, Some("")) {
        return Err("call: arguments argument is empty (a shell expansion likely produced nothing); pass a JSON object such as {} explicitly".to_string());
    }
    let text = arg
        .filter(|s| !s.is_empty())
        .or_else(|| Some(stdin).filter(|s| !s.trim().is_empty()))
        .unwrap_or("{}");
    serde_json::from_str(text).map_err(|e| format!("call: arguments is not valid JSON: {e}"))
}

/// `<server> prompt <name> [--arg k=v ...]`: collect `--arg k=v` pairs into a
/// string-valued arguments object.
fn prompt_arguments(args: &[String]) -> Result<Value, String> {
    let mut map = serde_json::Map::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--arg" {
            let pair = args
                .get(i + 1)
                .ok_or_else(|| "prompt: --arg requires a k=v value".to_string())?;
            let (key, value) = pair
                .split_once('=')
                .ok_or_else(|| format!("prompt: --arg value '{pair}' is not k=v"))?;
            map.insert(key.to_string(), Value::String(value.to_string()));
            i += 2;
        } else {
            return Err(format!("prompt: unexpected argument '{}'", args[i]));
        }
    }
    Ok(Value::Object(map))
}

fn valid_server_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn has_server_signature(name: &str, wit: &str) -> bool {
    let compact: String = wit.chars().filter(|c| !c.is_whitespace()).collect();
    let compact = compact.replace(",>", ">");
    let prefix = format!("{name}:func(method:string,params-json:string)->");
    let Some(tail) = compact
        .split_once(&prefix)
        .map(|(_, tail)| tail.split(';').next().unwrap_or(""))
    else {
        return false;
    };
    tail == "result<string,string>"
}

fn required<'a>(value: Option<&'a str>, label: &str) -> Result<&'a str, String> {
    match value {
        Some(v) if !v.is_empty() => Ok(v),
        _ => Err(format!("{label} is required")),
    }
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn ensure_newline(mut text: String) -> String {
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

fn ok(stdout: String) -> CommandOutput {
    CommandOutput {
        stdout,
        stderr: String::new(),
        exit_code: 0,
    }
}

fn fail(stderr: String) -> CommandOutput {
    CommandOutput {
        stdout: String::new(),
        stderr,
        exit_code: 1,
    }
}

fn server_help(server: &str) -> String {
    format!(
        "Usage: {server} <subcommand>\n\
\n\
Subcommands:\n\
  tools                     List the server's tools (tools/list)\n\
  call TOOL [JSON-ARGS]     Call a tool (tools/call); args from stdin if omitted\n\
  prompts                   List the server's prompts (prompts/list)\n\
  prompt NAME [--arg k=v]   Render a prompt to stdout (prompts/get)\n\
  info                      Show server metadata (server/discover)\n"
    )
}

fn registry_help() -> String {
    "Usage: mcp <subcommand>\n\
\n\
Subcommands:\n\
  list        List configured MCP servers with URL and auth status (default)\n\
  tools       List tools across all configured servers\n"
        .to_string()
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
        fn new() -> Self {
            Self {
                responses: BTreeMap::new(),
                calls: Vec::new(),
            }
        }

        fn with(mut self, ffqn: &str, response: &str) -> Self {
            self.responses
                .insert(ffqn.to_string(), Ok(Some(response.to_string())));
            self
        }
    }

    impl ObeliskHost for FakeHost {
        fn call_json(&mut self, ffqn: &str, params_json: &str) -> Result<Option<String>, String> {
            self.calls.push((ffqn.to_string(), params_json.to_string()));
            self.responses
                .get(ffqn)
                .cloned()
                .unwrap_or_else(|| Err(format!("no fixture for {ffqn}")))
        }
    }

    /// The activity's ok arm is a JSON string; `call_json` returns that string's
    /// JSON text (i.e. quoted), so a fixture must double-encode the payload.
    fn ok_arm(payload: Value) -> String {
        serde_json::to_string(&payload.to_string()).unwrap()
    }

    fn words(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn discovers_only_matching_server_exports() {
        let functions = json!([
            {
                "ffqn": "obelisk-agent:mcp/server.obelisk-local",
                "wit": "package obelisk-agent:mcp;\ninterface server {\n  obelisk-local: func(method: string, params-json: string) -> result<string, string>;\n}"
            },
            {
                "ffqn": "obelisk-agent:mcp/server.bad",
                "wit": "interface server { bad: func(method: string) -> string; }"
            },
            {
                "ffqn": "elsewhere:mcp/server.other",
                "wit": "interface server { other: func(method: string, params-json: string) -> result<string, string>; }"
            }
        ]);
        let response = serde_json::to_string(&functions.to_string()).unwrap();
        let mut host = FakeHost::new().with(LIST_FUNCTIONS_FFQN, &response);

        assert_eq!(
            discover(&mut host).unwrap(),
            vec![Server {
                name: "obelisk-local".to_string(),
                ffqn: "obelisk-agent:mcp/server.obelisk-local".to_string(),
            }]
        );
        assert_eq!(
            host.calls,
            vec![(
                LIST_FUNCTIONS_FFQN.to_string(),
                "[\"obelisk-agent:mcp/server.\",100]".to_string(),
            )]
        );
    }

    #[test]
    fn tools_forwards_method_and_prints_tool_array() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let mut host = FakeHost::new().with(
            ffqn,
            &ok_arm(json!({"tools": [{"name": "calculate", "description": "adds"}]})),
        );
        let out = run_server("demo", ffqn, &words(&["tools"]), "", &mut host).unwrap();
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.contains("\"calculate\""));
        assert_eq!(
            host.calls[0],
            (ffqn.to_string(), "[\"tools/list\",\"{}\"]".to_string())
        );
    }

    #[test]
    fn call_forwards_tool_name_and_arguments_and_renders_text() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let mut host = FakeHost::new().with(
            ffqn,
            &ok_arm(json!({"content": [{"type": "text", "text": "42"}]})),
        );
        let out = run_server(
            "demo",
            ffqn,
            &words(&["call", "calculate", "{\"a\":1}"]),
            "",
            &mut host,
        )
        .unwrap();
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout, "42\n");
        assert_eq!(
            host.calls[0].1,
            "[\"tools/call\",\"{\\\"name\\\":\\\"calculate\\\",\\\"arguments\\\":{\\\"a\\\":1}}\"]"
        );
    }

    #[test]
    fn call_reads_arguments_from_stdin_when_positional_absent() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let mut host = FakeHost::new().with(
            ffqn,
            &ok_arm(json!({"content": [{"type": "text", "text": "ok"}]})),
        );
        run_server("demo", ffqn, &words(&["call", "t"]), "{\"b\":2}", &mut host).unwrap();
        assert_eq!(
            host.calls[0].1,
            "[\"tools/call\",\"{\\\"name\\\":\\\"t\\\",\\\"arguments\\\":{\\\"b\\\":2}}\"]"
        );
    }

    #[test]
    fn call_rejects_explicitly_empty_arguments() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let mut host = FakeHost::new().with(ffqn, &ok_arm(json!({})));
        let err = match run_server("demo", ffqn, &words(&["call", "t", ""]), "", &mut host) {
            Err(message) => message,
            Ok(_) => panic!("expected an empty-arguments error"),
        };
        assert!(err.contains("arguments argument is empty"));
        assert!(host.calls.is_empty());
    }

    #[test]
    fn error_tool_result_goes_to_stderr_with_nonzero_exit() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let mut host = FakeHost::new().with(
            ffqn,
            &ok_arm(json!({"isError": true, "content": [{"type": "text", "text": "boom"}]})),
        );
        let out = run_server("demo", ffqn, &words(&["call", "t", "{}"]), "", &mut host).unwrap();
        assert_eq!(out.exit_code, 1);
        assert_eq!(out.stderr, "boom\n");
    }

    #[test]
    fn prompt_collects_arg_pairs_and_renders_messages() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let mut host = FakeHost::new().with(
            ffqn,
            &ok_arm(json!({
                "description": "next tool",
                "messages": [{"role": "user", "content": {"type": "text", "text": "design it"}}]
            })),
        );
        let out = run_server(
            "demo",
            ffqn,
            &words(&["prompt", "design-next-tool", "--arg", "topic=math"]),
            "",
            &mut host,
        )
        .unwrap();
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.contains("# next tool"));
        assert!(out.stdout.contains("[user] design it"));
        assert_eq!(
            host.calls[0].1,
            "[\"prompts/get\",\"{\\\"name\\\":\\\"design-next-tool\\\",\\\"arguments\\\":{\\\"topic\\\":\\\"math\\\"}}\"]"
        );
    }

    #[test]
    fn host_err_arm_is_a_command_failure() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let mut host = FakeHost::new();
        host.responses
            .insert(ffqn.to_string(), Err("tool exploded".to_string()));
        let out = run_server("demo", ffqn, &words(&["tools"]), "", &mut host)
            .unwrap_or_else(|e| fail(format!("demo: {e}\n")));
        assert_eq!(out.exit_code, 1);
        assert!(out.stderr.contains("tool exploded"));
    }

    #[test]
    fn unknown_subcommand_reports_help() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let mut host = FakeHost::new();
        let out = run_server("demo", ffqn, &words(&["bogus"]), "", &mut host).unwrap();
        assert_eq!(out.exit_code, 1);
        assert!(out.stderr.contains("unknown subcommand 'bogus'"));
        assert!(out.stderr.contains("Usage: demo"));
    }

    #[test]
    fn registry_list_reports_url_and_auth_from_config_method() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let registry: ServerRegistry = Rc::new(RefCell::new(vec![Server {
            name: "demo".to_string(),
            ffqn: ffqn.to_string(),
        }]));
        let mut host = FakeHost::new().with(
            ffqn,
            &ok_arm(json!({"url": "http://127.0.0.1:1071/mcp", "auth": true})),
        );
        let out = run_registry(&registry, &[], &mut host).unwrap();
        assert_eq!(out.exit_code, 0);
        assert_eq!(
            out.stdout,
            "demo  url=http://127.0.0.1:1071/mcp  auth=yes\n"
        );
        assert_eq!(
            host.calls[0],
            (ffqn.to_string(), "[\"client/config\",\"{}\"]".to_string())
        );
    }

    #[test]
    fn registry_list_with_no_servers() {
        let registry: ServerRegistry = Rc::new(RefCell::new(Vec::new()));
        let mut host = FakeHost::new();
        let out = run_registry(&registry, &words(&["list"]), &mut host).unwrap();
        assert_eq!(out.stdout, "No MCP servers are configured.\n");
        assert!(host.calls.is_empty());
    }
}
