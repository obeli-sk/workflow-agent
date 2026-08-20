//! Command adapters for stateless MCP servers.
//!
//! Each configured MCP server is one deployed activity with the uniform
//! stateless-transport contract:
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
use std::collections::BTreeMap;
use std::rc::Rc;

use serde_json::{Value, json};

use crate::custom_command::CustomCommandHandler;
use crate::fs::{BlobLoader, Vfs};
use crate::interpreter::CommandOutput;
use crate::obelisk_pack::ObeliskHost;

/// Pseudo-method served inline by the transport activity (no HTTP): reports the
/// configured endpoint URL and whether a bearer token is set, so `mcp list` can
/// describe each server without reaching the network.
const CONFIG_METHOD: &str = "client/config";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Server {
    pub name: String,
    pub ffqn: String,
}

/// The shared set of registered servers backing the global `mcp` command.
pub type ServerRegistry = Rc<RefCell<Vec<Server>>>;

// ===== resources: an MCP server's files, mounted lazily into the VFS ==========
//
// A server that exposes files does so through the standard MCP resource
// methods: `resources/list` enumerates them (cheap, metadata only), and
// `resources/read` returns one resource's bytes on demand. This mirrors what
// the obelisk-control pack does today with `deployment-checkout` (one listing)
// plus `deployment-read-blob` (lazy per-file fetch), so an MCP server can back
// the session VFS with no pack-specific host calls.
//
// The conventions this layer adds on top of the base spec:
//
//   * A resource's content digest travels in `_meta` under
//     [`RESOURCE_DIGEST_META_KEY`], because `resources/list` has a standard
//     `size` field but no digest. The digest is the file's content identity,
//     used exactly as `deployment-checkout` digests are: the lazy-fetch/dedup
//     key and (later) submit re-pinning.
//   * The resource's VFS path is its `name` (the spec's logical/programmatic
//     name), so `uri` stays fully opaque: a stateless server is free to encode
//     the digest in the `uri` and answer `resources/read` in one call without
//     re-listing. A server that omits `name` falls back to a path derived from
//     the `uri`. The loader passes `uri` through verbatim and keeps a
//     digest -> uri map from the listing; the VFS itself only ever sees the
//     path and the sha256 digest it already understands, never a uri.

/// `_meta` key carrying a resource's `sha256:<hex>` content digest in
/// `resources/list` output. `_meta` keys are namespaced (reverse-DNS prefix
/// before the `/`); this is obeli.sk's. Change here and in the webhook together.
pub const RESOURCE_DIGEST_META_KEY: &str = "sk.obeli/content-digest";

/// Guard against a server that never stops paginating `resources/list`.
const MAX_RESOURCE_PAGES: usize = 1000;

/// One resource from `resources/list`, reduced to what the VFS mount needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceRef {
    /// The opaque MCP URI; the key `resources/read` fetches by.
    pub uri: String,
    /// VFS-relative path derived from the URI (scheme and authority stripped).
    pub path: String,
    /// `sha256:<hex>` content identity, read from `_meta`.
    pub digest: String,
    /// Authoritative byte length, from the resource's `size` field.
    pub size: u64,
}

/// Enumerate a server's resources, following `nextCursor` across pages. Each
/// entry must carry `size` and the [`RESOURCE_DIGEST_META_KEY`] digest, matching
/// what `deployment-checkout` file entries provide today.
pub fn list_resources(host: &mut dyn ObeliskHost, ffqn: &str) -> Result<Vec<ResourceRef>, String> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_RESOURCE_PAGES {
        let params = match &cursor {
            Some(c) => json!({ "cursor": c }),
            None => json!({}),
        };
        let page = rpc(host, ffqn, "resources/list", params)?;
        let resources = page
            .get("resources")
            .and_then(Value::as_array)
            .ok_or_else(|| "resources/list returned no resources array".to_string())?;
        for resource in resources {
            out.push(parse_resource(resource)?);
        }
        match page.get("nextCursor").and_then(Value::as_str) {
            Some(next) if !next.is_empty() => cursor = Some(next.to_string()),
            _ => return Ok(out),
        }
    }
    Err("resources/list exceeded the maximum page count".to_string())
}

fn parse_resource(resource: &Value) -> Result<ResourceRef, String> {
    let uri = resource
        .get("uri")
        .and_then(Value::as_str)
        .ok_or_else(|| "resource entry has no uri".to_string())?;
    let size = resource
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("resource {uri} has no size"))?;
    let digest = resource
        .get("_meta")
        .and_then(|meta| meta.get(RESOURCE_DIGEST_META_KEY))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("resource {uri} has no {RESOURCE_DIGEST_META_KEY} in _meta"))?;
    if !valid_sha256_digest(digest) {
        return Err(format!("resource {uri} has an invalid sha256 digest"));
    }
    let path = resource
        .get("name")
        .and_then(Value::as_str)
        .map(|name| name.trim_start_matches('/').to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| uri_to_path(uri));
    if path.is_empty() || path.split('/').any(|part| part == "." || part == "..") {
        return Err(format!("resource {uri} has an unsafe VFS path"));
    }
    Ok(ResourceRef {
        uri: uri.to_string(),
        path,
        digest: digest.to_string(),
        size,
    })
}

fn valid_sha256_digest(digest: &str) -> bool {
    digest
        .strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// The VFS-relative path for a resource URI: everything after
/// `scheme://authority`, with any leading slash removed. `file:///a/b.toml` ->
/// `a/b.toml`; `obelisk://host/components/w.wasm` -> `components/w.wasm`; a URI
/// with no `://` is taken verbatim (leading slash trimmed).
fn uri_to_path(uri: &str) -> String {
    let after_scheme = match uri.split_once("://") {
        Some((_, rest)) => rest
            .split_once('/')
            .map(|(_authority, path)| path)
            .unwrap_or(""),
        None => uri,
    };
    after_scheme.trim_start_matches('/').to_string()
}

/// Mount a server's resources into `fs` under `mount_dir`, lazily: list them
/// once, register each as a `pending` VFS entry keyed by its sha256 digest, and
/// install a loader that fetches a bounded file's bytes via `resources/read` on
/// first access. `list_host` drives the listing; `loader_host` is owned by the
/// installed loader (a `&self` fetch on read, like the CAS loader). Returns the
/// mounted refs.
///
pub fn mount_resources(
    fs: &mut Vfs,
    list_host: &mut dyn ObeliskHost,
    loader_host: Box<dyn ObeliskHost>,
    ffqn: &str,
    mount_dir: &str,
) -> Result<Vec<ResourceRef>, String> {
    let refs = list_resources(list_host, ffqn)?;
    let dir = mount_dir.trim_end_matches('/');
    let loader = resource_loader(loader_host, ffqn, &refs);
    for reference in &refs {
        fs.register_lazy_with_loader(
            &format!("{dir}/{}", reference.path),
            &reference.digest,
            reference.size,
            loader.clone(),
        );
    }
    Ok(refs)
}

/// The VFS blob loader for a resource-backed mount: read a file's bytes via
/// `resources/read`, resolving the digest the VFS holds back to the URI the
/// listing paired it with. Two resources with identical content share a digest
/// and thus one URI, which is fine (the bytes are identical).
struct McpResourceLoader {
    host: RefCell<Box<dyn ObeliskHost>>,
    ffqn: String,
    uri_by_digest: BTreeMap<String, String>,
}

impl BlobLoader for McpResourceLoader {
    fn load(&self, digest: &str) -> Result<Vec<u8>, String> {
        let uri = self
            .uri_by_digest
            .get(digest)
            .ok_or_else(|| format!("no MCP resource for digest {digest}"))?;
        let result = rpc(
            &mut **self.host.borrow_mut(),
            &self.ffqn,
            "resources/read",
            json!({ "uri": uri }),
        )?;
        resource_bytes(&result)
    }
}

fn resource_loader(
    host: Box<dyn ObeliskHost>,
    ffqn: impl Into<String>,
    refs: &[ResourceRef],
) -> Rc<dyn BlobLoader> {
    let uri_by_digest = refs
        .iter()
        .map(|reference| (reference.digest.clone(), reference.uri.clone()))
        .collect();
    Rc::new(McpResourceLoader {
        host: RefCell::new(host),
        ffqn: ffqn.into(),
        uri_by_digest,
    })
}

/// Decode the first content item of a `resources/read` result to raw bytes: a
/// `text` item is UTF-8; a `blob` item is base64 (RFC 4648).
fn resource_bytes(result: &Value) -> Result<Vec<u8>, String> {
    let first = result
        .get("contents")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "resources/read returned no contents".to_string())?;
    if let Some(text) = first.get("text").and_then(Value::as_str) {
        return Ok(text.as_bytes().to_vec());
    }
    if let Some(blob) = first.get("blob").and_then(Value::as_str) {
        return base64_decode(blob);
    }
    Err("resources/read content has neither text nor blob".to_string())
}

/// Standard base64 decode (RFC 4648), skipping padding and any whitespace. No
/// base64 crate is in the dependency set and blob resources are the only caller.
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0u32;
    for &byte in input.as_bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let value = sextet(byte).ok_or_else(|| format!("invalid base64 byte {byte:#x}"))? as u32;
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

/// Adapt one configured server to a just-bash command:
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
        "tools" => run_tools(server, ffqn, rest, stdin, host),
        "call" => {
            if rest == ["--help"] {
                return Ok(ok(call_help(server)));
            }
            let tool = required(rest.first().map(String::as_str), "tool name")?;
            if rest.get(1).map(String::as_str) == Some("--help") {
                return Ok(ok(tool_help_for(server, "call", tool, ffqn, host)?));
            }
            call_tool(ffqn, tool, &rest[1..], stdin, host)
        }
        "prompts" => run_prompts(server, ffqn, rest, host),
        "prompt" => {
            if rest == ["--help"] {
                return Ok(ok(prompt_collection_help(server, "prompt")));
            }
            let name = required(rest.first().map(String::as_str), "prompt name")?;
            if rest.get(1).map(String::as_str) == Some("--help") {
                return Ok(ok(prompt_help_for(server, "prompt", name, ffqn, host)?));
            }
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
            if rest == ["--help"] {
                return Ok(ok(format!(
                    "Usage: {server} info\n\nShow server metadata and capabilities.\n"
                )));
            }
            let result = rpc(host, ffqn, "server/discover", json!({}))?;
            Ok(ok(ensure_newline(pretty(&result))))
        }
        other => Ok(fail(format!(
            "{server}: unknown subcommand '{other}'\n{}",
            server_help(server)
        ))),
    }
}

fn run_tools(
    server: &str,
    ffqn: &str,
    args: &[String],
    stdin: &str,
    host: &mut dyn ObeliskHost,
) -> Result<CommandOutput, String> {
    if args == ["--help"] {
        return Ok(ok(tools_help(server)));
    }
    let Some(tool) = args.first().map(String::as_str) else {
        let result = rpc(host, ffqn, "tools/list", json!({}))?;
        return Ok(ok(pretty_list(&result, "tools")));
    };
    if args.get(1).map(String::as_str) == Some("--help") {
        return Ok(ok(tool_help_for(server, "tools", tool, ffqn, host)?));
    }
    call_tool(ffqn, tool, &args[1..], stdin, host)
}

fn call_tool(
    ffqn: &str,
    tool: &str,
    args: &[String],
    stdin: &str,
    host: &mut dyn ObeliskHost,
) -> Result<CommandOutput, String> {
    let arguments = tool_arguments(args, stdin)?;
    let result = rpc(
        host,
        ffqn,
        "tools/call",
        json!({"name": tool, "arguments": arguments}),
    )?;
    Ok(render_tool_result(&result))
}

fn run_prompts(
    server: &str,
    ffqn: &str,
    args: &[String],
    host: &mut dyn ObeliskHost,
) -> Result<CommandOutput, String> {
    if args == ["--help"] {
        return Ok(ok(prompt_collection_help(server, "prompts")));
    }
    let Some(name) = args.first().map(String::as_str) else {
        let result = rpc(host, ffqn, "prompts/list", json!({}))?;
        return Ok(ok(pretty_list(&result, "prompts")));
    };
    if args.get(1).map(String::as_str) == Some("--help") {
        return Ok(ok(prompt_help_for(server, "prompts", name, ffqn, host)?));
    }
    let arguments = prompt_arguments(&args[1..])?;
    let result = rpc(
        host,
        ffqn,
        "prompts/get",
        json!({"name": name, "arguments": arguments}),
    )?;
    Ok(ok(render_prompt(&result)))
}

fn run_registry(
    registry: &ServerRegistry,
    args: &[String],
    host: &mut dyn ObeliskHost,
) -> Result<CommandOutput, String> {
    let action = args.first().map(String::as_str).unwrap_or("");
    let servers = registry.borrow().clone();
    match action {
        "--help" | "help" => Ok(ok(registry_help())),
        "list" if args.get(1).map(String::as_str) == Some("--help") => Ok(ok(
            "Usage: mcp list\n\nList configured MCP servers with URL and auth status.\n"
                .to_string(),
        )),
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
        "tools" if args.get(1).map(String::as_str) == Some("--help") => Ok(ok(
            "Usage: mcp tools\n\nList tools across all configured MCP servers.\n".to_string(),
        )),
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

/// Accept one JSON object, `--arg key=value`, or ordinary `--key value` flags.
fn tool_arguments(args: &[String], stdin: &str) -> Result<Value, String> {
    if matches!(args.first().map(String::as_str), Some("")) {
        return Err("call: arguments argument is empty (a shell expansion likely produced nothing); pass a JSON object such as {} explicitly".to_string());
    }
    if let Some(first) = args.first().filter(|arg| !arg.starts_with("--")) {
        if args.len() != 1 {
            return Err("call: JSON arguments must be a single positional value".to_string());
        }
        return parse_argument_object(first);
    }
    if args.is_empty() {
        return match stdin.trim() {
            "" => Ok(json!({})),
            text => parse_argument_object(text),
        };
    }
    flag_arguments(args, "call", true)
}

fn parse_argument_object(text: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|e| format!("call: arguments is not valid JSON: {e}"))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err("call: arguments must be a JSON object".to_string())
    }
}

/// Prompt arguments are strings in MCP, but accept both generic and named flags.
fn prompt_arguments(args: &[String]) -> Result<Value, String> {
    flag_arguments(args, "prompt", false)
}

fn flag_arguments(
    args: &[String],
    command: &str,
    parse_json_values: bool,
) -> Result<Value, String> {
    let mut map = serde_json::Map::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--arg" {
            let pair = args
                .get(i + 1)
                .ok_or_else(|| format!("{command}: --arg requires a k=v value"))?;
            let (key, value) = pair
                .split_once('=')
                .ok_or_else(|| format!("{command}: --arg value '{pair}' is not k=v"))?;
            insert_flag_value(&mut map, key, value, parse_json_values)?;
            i += 2;
        } else if let Some(flag) = args[i].strip_prefix("--") {
            if flag.is_empty() {
                return Err(format!("{command}: invalid argument '--'"));
            }
            if let Some((key, value)) = flag.split_once('=') {
                insert_flag_value(&mut map, key, value, parse_json_values)?;
                i += 1;
            } else {
                let value = args
                    .get(i + 1)
                    .ok_or_else(|| format!("{command}: --{flag} requires a value"))?;
                insert_flag_value(&mut map, flag, value, parse_json_values)?;
                i += 2;
            }
        } else {
            return Err(format!("{command}: unexpected argument '{}'", args[i]));
        }
    }
    Ok(Value::Object(map))
}

fn insert_flag_value(
    map: &mut serde_json::Map<String, Value>,
    key: &str,
    value: &str,
    parse_json_value: bool,
) -> Result<(), String> {
    if key.is_empty() {
        return Err("argument name cannot be empty".to_string());
    }
    let value = if parse_json_value {
        serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_string()))
    } else {
        Value::String(value.to_string())
    };
    map.insert(key.to_string(), value);
    Ok(())
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

fn tool_help_for(
    server: &str,
    command: &str,
    name: &str,
    ffqn: &str,
    host: &mut dyn ObeliskHost,
) -> Result<String, String> {
    let result = rpc(host, ffqn, "tools/list", json!({}))?;
    let tool = named_entry(&result, "tools", name)
        .ok_or_else(|| format!("tool '{name}' was not found"))?;
    let mut out = format!("Usage: {server} {command} {name} [OPTIONS]\n");
    if let Some(description) = tool.get("description").and_then(Value::as_str) {
        out.push_str(&format!("\n{description}\n"));
    }
    out.push_str("\nOptions:\n");
    let schema = tool.get("inputSchema").or_else(|| tool.get("input_schema"));
    let properties = schema
        .and_then(|value| value.get("properties"))
        .and_then(Value::as_object);
    let required = schema
        .and_then(|value| value.get("required"))
        .and_then(Value::as_array);
    if let Some(properties) = properties {
        for (key, property) in properties {
            let kind = property
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("value");
            let marker = if required
                .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(key)))
            {
                " (required)"
            } else {
                ""
            };
            let description = property
                .get("description")
                .and_then(Value::as_str)
                .map(|text| format!("  {text}"))
                .unwrap_or_default();
            out.push_str(&format!("  --{key} <{kind}>{marker}{description}\n"));
        }
    }
    out.push_str("  --arg KEY=VALUE       Generic argument form; repeatable\n");
    out.push_str("  --help                Show this help\n");
    out.push_str("\nA JSON object can also be passed as one positional argument.\n");
    Ok(out)
}

fn prompt_help_for(
    server: &str,
    command: &str,
    name: &str,
    ffqn: &str,
    host: &mut dyn ObeliskHost,
) -> Result<String, String> {
    let result = rpc(host, ffqn, "prompts/list", json!({}))?;
    let prompt = named_entry(&result, "prompts", name)
        .ok_or_else(|| format!("prompt '{name}' was not found"))?;
    let mut out = format!("Usage: {server} {command} {name} [OPTIONS]\n");
    if let Some(description) = prompt.get("description").and_then(Value::as_str) {
        out.push_str(&format!("\n{description}\n"));
    }
    out.push_str("\nOptions:\n");
    if let Some(arguments) = prompt.get("arguments").and_then(Value::as_array) {
        for argument in arguments {
            let Some(key) = argument.get("name").and_then(Value::as_str) else {
                continue;
            };
            let marker = if argument
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                " (required)"
            } else {
                ""
            };
            let description = argument
                .get("description")
                .and_then(Value::as_str)
                .map(|text| format!("  {text}"))
                .unwrap_or_default();
            out.push_str(&format!("  --{key} <string>{marker}{description}\n"));
        }
    }
    out.push_str("  --arg KEY=VALUE       Generic argument form; repeatable\n");
    out.push_str("  --help                Show this help\n");
    Ok(out)
}

fn named_entry<'a>(result: &'a Value, collection: &str, name: &str) -> Option<&'a Value> {
    result
        .get(collection)
        .and_then(Value::as_array)?
        .iter()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
}

fn tools_help(server: &str) -> String {
    format!(
        "Usage: {server} tools [TOOL [OPTIONS]]\n\nList tools, or invoke TOOL directly.\n\nExamples:\n  {server} tools\n  {server} tools TOOL --help\n  {server} tools TOOL --arg key=value\n  {server} tools TOOL --key value\n"
    )
}

fn call_help(server: &str) -> String {
    format!(
        "Usage: {server} call TOOL [OPTIONS|JSON-ARGS]\n\nCall a tool. Run `{server} call TOOL --help` for its schema.\n"
    )
}

fn prompt_collection_help(server: &str, command: &str) -> String {
    format!(
        "Usage: {server} {command} [NAME [OPTIONS]]\n\nList prompts when NAME is omitted, or render one by name.\nRun `{server} {command} NAME --help` for its arguments.\n"
    )
}

fn server_help(server: &str) -> String {
    format!(
        "Usage: {server} <subcommand>\n\
\n\
Subcommands:\n\
  tools [TOOL [OPTIONS]]    List tools or invoke one directly\n\
  call TOOL [OPTIONS|JSON]  Call a tool; args from stdin if omitted\n\
  prompts [NAME [OPTIONS]]  List prompts or render one directly\n\
  prompt NAME [OPTIONS]     Render a prompt to stdout\n\
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
    fn tool_help_is_generated_from_its_input_schema() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let mut host = FakeHost::new().with(
            ffqn,
            &ok_arm(json!({"tools": [{
                "name": "add",
                "description": "Add two numbers",
                "inputSchema": {
                    "type": "object",
                    "properties": {"a": {"type": "number", "description": "First number"}, "b": {"type": "number"}},
                    "required": ["a", "b"]
                }
            }]})),
        );
        let out = run_server(
            "demo",
            ffqn,
            &words(&["tools", "add", "--help"]),
            "",
            &mut host,
        )
        .unwrap();
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.contains("Usage: demo tools add [OPTIONS]"));
        assert!(out.stdout.contains("--a <number> (required)  First number"));
        assert!(out.stdout.contains("--arg KEY=VALUE"));
        assert_eq!(host.calls[0].1, "[\"tools/list\",\"{}\"]");
    }

    #[test]
    fn tools_invokes_a_named_tool_with_typed_flags() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let mut host = FakeHost::new().with(
            ffqn,
            &ok_arm(json!({"content": [{"type": "text", "text": "4"}]})),
        );
        let out = run_server(
            "demo",
            ffqn,
            &words(&["tools", "add", "--arg", "a=1", "--b", "3"]),
            "",
            &mut host,
        )
        .unwrap();
        assert_eq!(out.stdout, "4\n");
        assert_eq!(
            host.calls[0].1,
            "[\"tools/call\",\"{\\\"name\\\":\\\"add\\\",\\\"arguments\\\":{\\\"a\\\":1,\\\"b\\\":3}}\"]"
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
    fn prompt_help_and_named_flags_use_discovered_arguments() {
        let ffqn = "obelisk-agent:mcp/server.demo";
        let listing = ok_arm(json!({"prompts": [{
            "name": "greeting",
            "description": "Greet someone",
            "arguments": [{"name": "name", "description": "Who to greet", "required": true}]
        }]}));
        let mut help_host = FakeHost::new().with(ffqn, &listing);
        let help = run_server(
            "demo",
            ffqn,
            &words(&["prompt", "greeting", "--help"]),
            "",
            &mut help_host,
        )
        .unwrap();
        assert!(
            help.stdout
                .contains("Usage: demo prompt greeting [OPTIONS]")
        );
        assert!(
            help.stdout
                .contains("--name <string> (required)  Who to greet")
        );

        let mut call_host = FakeHost::new().with(
            ffqn,
            &ok_arm(
                json!({"messages": [{"role": "user", "content": {"type": "text", "text": "hi"}}]}),
            ),
        );
        run_server(
            "demo",
            ffqn,
            &words(&["prompt", "greeting", "--name", "foo"]),
            "",
            &mut call_host,
        )
        .unwrap();
        assert_eq!(
            call_host.calls[0].1,
            "[\"prompts/get\",\"{\\\"name\\\":\\\"greeting\\\",\\\"arguments\\\":{\\\"name\\\":\\\"foo\\\"}}\"]"
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

    // -- resources: listing, uri->path mapping, and lazy read-by-uri --

    /// A host that routes by MCP method (and, for reads, by resource uri) so one
    /// fake can answer `resources/list` pages and `resources/read` calls. The
    /// params handed to `call_json` are `["<method>", "<params-json>"]`, and the
    /// ok arm is double-encoded exactly like `FakeHost`'s (see `ok_arm`).
    struct ResourceHost {
        pages: Vec<String>,
        reads: BTreeMap<String, String>,
        calls: Vec<(String, String)>,
    }

    impl ResourceHost {
        fn new() -> Self {
            Self {
                pages: Vec::new(),
                reads: BTreeMap::new(),
                calls: Vec::new(),
            }
        }
    }

    impl ObeliskHost for ResourceHost {
        fn call_json(&mut self, ffqn: &str, params_json: &str) -> Result<Option<String>, String> {
            self.calls.push((ffqn.to_string(), params_json.to_string()));
            let outer: Value = serde_json::from_str(params_json).unwrap();
            let method = outer.get(0).and_then(Value::as_str).unwrap_or("");
            let inner: Value =
                serde_json::from_str(outer.get(1).and_then(Value::as_str).unwrap_or("{}")).unwrap();
            match method {
                "resources/list" => {
                    let idx = match inner.get("cursor").and_then(Value::as_str) {
                        Some(cursor) => {
                            cursor.trim_start_matches('p').parse::<usize>().unwrap_or(0)
                        }
                        None => 0,
                    };
                    self.pages
                        .get(idx)
                        .cloned()
                        .map(Some)
                        .ok_or_else(|| format!("no page {idx}"))
                }
                "resources/read" => {
                    let uri = inner.get("uri").and_then(Value::as_str).unwrap_or("");
                    self.reads
                        .get(uri)
                        .cloned()
                        .map(Some)
                        .ok_or_else(|| format!("no read fixture for {uri}"))
                }
                other => Err(format!("unexpected method {other}")),
            }
        }
    }

    #[test]
    fn list_resources_reads_size_and_meta_digest_and_maps_uri_to_path() {
        assert_eq!(RESOURCE_DIGEST_META_KEY, "sk.obeli/content-digest");
        let ffqn = "obelisk-agent:mcp/server.obelisk";
        let mut host = ResourceHost::new();
        host.pages.push(ok_arm(json!({
            "resources": [
                // Opaque digest-encoded uri with a logical `name` path.
                {"uri": "obelisk-blob:sha256:aa", "name": "deployment.toml", "size": 12,
                 "_meta": {"sk.obeli/content-digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},
                // No `name`: the path falls back to the uri.
                {"uri": "obelisk://srv/components/w.wasm", "size": 3_000_000,
                 "_meta": {"sk.obeli/content-digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}
            ]
        })));
        let refs = list_resources(&mut host, ffqn).unwrap();
        assert_eq!(
            refs,
            vec![
                ResourceRef {
                    uri: "obelisk-blob:sha256:aa".into(),
                    path: "deployment.toml".into(),
                    digest:
                        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                            .into(),
                    size: 12,
                },
                ResourceRef {
                    uri: "obelisk://srv/components/w.wasm".into(),
                    path: "components/w.wasm".into(),
                    digest:
                        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                            .into(),
                    size: 3_000_000,
                },
            ]
        );
        assert_eq!(host.calls[0].1, "[\"resources/list\",\"{}\"]");
    }

    #[test]
    fn list_resources_follows_next_cursor() {
        let ffqn = "obelisk-agent:mcp/server.obelisk";
        let mut host = ResourceHost::new();
        host.pages.push(ok_arm(json!({
            "resources": [{"uri": "file:///a", "size": 1,
                           "_meta": {"sk.obeli/content-digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}],
            "nextCursor": "p1"
        })));
        host.pages.push(ok_arm(json!({
            "resources": [{"uri": "file:///b", "size": 1,
                           "_meta": {"sk.obeli/content-digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}]
        })));
        let refs = list_resources(&mut host, ffqn).unwrap();
        assert_eq!(
            refs.iter().map(|r| r.path.clone()).collect::<Vec<_>>(),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(host.calls.len(), 2);
        assert!(host.calls[1].1.contains("cursor") && host.calls[1].1.contains("p1"));
    }

    #[test]
    fn parse_resource_requires_size_and_digest() {
        let no_size = json!({"uri": "file:///a", "_meta": {"sk.obeli/content-digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}});
        assert!(parse_resource(&no_size).unwrap_err().contains("no size"));
        let no_digest = json!({"uri": "file:///a", "size": 1});
        assert!(
            parse_resource(&no_digest)
                .unwrap_err()
                .contains("sk.obeli/content-digest")
        );
        let unsafe_path = json!({
            "uri": "sample://files/escape",
            "name": "../../escape",
            "size": 1,
            "_meta": {"sk.obeli/content-digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        });
        assert!(
            parse_resource(&unsafe_path)
                .unwrap_err()
                .contains("unsafe VFS path")
        );
    }

    #[test]
    fn mount_resources_registers_lazy_then_reads_text_and_blob_by_uri() {
        let ffqn = "obelisk-agent:mcp/server.obelisk";
        let mut list_host = ResourceHost::new();
        list_host.pages.push(ok_arm(json!({
            "resources": [
                {"uri": "file:///deployment.toml", "size": 5,
                 "_meta": {"sk.obeli/content-digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}},
                {"uri": "file:///x.bin", "size": 3,
                 "_meta": {"sk.obeli/content-digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}
            ]
        })));
        let mut loader_host = ResourceHost::new();
        loader_host.reads.insert(
            "file:///deployment.toml".into(),
            ok_arm(json!({"contents": [{"uri": "file:///deployment.toml", "text": "hello"}]})),
        );
        // base64 "AAEC" -> bytes 0x00 0x01 0x02.
        loader_host.reads.insert(
            "file:///x.bin".into(),
            ok_arm(json!({"contents": [{"uri": "file:///x.bin", "blob": "AAEC"}]})),
        );

        let mut fs = Vfs::new();
        let refs = mount_resources(
            &mut fs,
            &mut list_host,
            Box::new(loader_host),
            ffqn,
            "/workspace/deployment/current",
        )
        .unwrap();
        assert_eq!(refs.len(), 2);
        // Listing registers structure without fetching any body.
        assert!(fs.is_file("/workspace/deployment/current/deployment.toml"));
        assert!(
            list_host
                .calls
                .iter()
                .all(|(_, params)| params.contains("resources/list"))
        );

        assert_eq!(
            fs.read_file("/workspace/deployment/current/deployment.toml")
                .as_deref(),
            Some(&b"hello"[..])
        );
        assert_eq!(
            fs.read_file("/workspace/deployment/current/x.bin")
                .as_deref(),
            Some(&[0u8, 1, 2][..])
        );
    }

    #[test]
    fn base64_decode_handles_padding_and_whitespace() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode("aGVs bG8=\n").unwrap(), b"hello");
        assert_eq!(base64_decode("AAEC").unwrap(), vec![0u8, 1, 2]);
        assert!(base64_decode("!!!!").is_err());
    }
}
