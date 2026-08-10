//! PORT: workflow/agent-loop-src.js
//!
//! The generic session loop: one persistent `Bash` instance, one named
//! `record-output` join set for the whole session, and one named
//! `operator-{turn}` join set per conversation turn racing the LLM completion
//! child against an always-outstanding operator-injection offer. Direct shell
//! interactions are turns too: their synthetic Bash request/result pair is
//! included in the next turn's completion request.
//!
//! Simplifications versus the JS version (see design doc for the full list):
//! - No `Shell{bash, cwd}` wrapper: `Bash::exec` already persists `cwd`
//!   internally (`bash.rs`), so this port threads a plain `&mut Bash`.
//! - No `console.log` tracing: this WIT world imports no logging interface
//!   (native components in this codebase don't wire one; see
//!   `demo-stargazers`'s workflow-rs), so the turn/step/dispatch/rate-limit
//!   log lines have no Rust equivalent and are dropped.
//! - No explicit `joinSet.close()` / `finally`: a WIT `join-set` resource
//!   closes on `Drop`, so scope exit (a fresh `Session` each turn, and the
//!   session-wide output join set falling out of scope when this function
//!   returns) already does the equivalent cleanup.
//! - `WORKFLOW_UNAVAILABLE_COMMANDS` (gzip/gunzip/zcat) has no Rust
//!   equivalent: this port's command catalog (`just_bash_rs::commands`) never
//!   included those commands in the first place, so there is nothing to
//!   filter out of `Bash`'s fixed builtin table.
//! - The fallback random event id (`String(Math.random())` in JS) uses
//!   `workflow_support::random_string`, the durable/deterministic source of
//!   randomness this WIT provides for exactly this purpose, instead of a
//!   host `Math.random()` shim.

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::rc::Rc;

use serde::Serialize;
use serde_json::{Value, json};

use just_bash_rs::{Bash, BashOptions, ExecOptions, ExecResult};
use just_bash_rs::{obelisk_mcp, obelisk_pack, obelisk_program};

use crate::generated::obelisk::types::time::Duration;
use crate::generated::obelisk::workflow::workflow_support::{self, JoinSet, ScheduleAt};
use crate::host::RealHost;
use crate::support::{child_error_message, last_response_execution_id, split_ffqn};

/// `date`'s clock: the current time from the durable Obelisk `sleep(now)` host
/// activity, as Unix epoch milliseconds. Read on demand by `date`, so a script
/// that never calls it pays no clock read. A cancelled read reports the epoch.
fn host_now_ms() -> i64 {
    match workflow_support::sleep(ScheduleAt::Now, None) {
        Ok(dt) => dt.seconds as i64 * 1000 + (dt.nanoseconds / 1_000_000) as i64,
        Err(_) => 0,
    }
}

/// `sleep`'s delay: the durable Obelisk `sleep(in(...))` host activity, which
/// suspends the workflow rather than busy-waiting. A zero delay is a no-op.
fn host_sleep_ms(ms: u64) {
    if ms == 0 {
        return;
    }
    let _ = workflow_support::sleep(ScheduleAt::In(Duration::Milliseconds(ms)), None);
}

/// The active deployment's id, used only to detect a redeploy between turns and
/// re-register program commands. The value is compared verbatim (a redeploy
/// yields a new id), so the exact JSON-string framing does not matter.
fn current_deployment_id() -> Result<String, String> {
    use just_bash_rs::obelisk_pack::ObeliskHost;
    RealHost
        .call_json("obelisk-agent:tools/webapi.current-deployment-id", "[]")?
        .ok_or_else(|| "current-deployment-id returned no body".to_string())
}

const MAX_TURNS: u32 = 10;
const MAX_TOOL_RESULT_BYTES: usize = 96 * 1024;
const INJECTION_FFQN: &str = "obelisk-agent:agent/session.injection";
const OUTPUT_FFQN: &str = "obelisk-agent:agent/session.record-output";
const COMPLETION_FFQN: &str = "obelisk-agent:llm/chat.completion";
// Keep in lockstep with `BASH_TOOLS_JSON` in agent-loop-src.js.
const BASH_TOOLS_JSON: &str = r#"[{"name":"bash","description":"Run a Bash script in the session persistent virtual workspace.","input_schema":{"type":"object","properties":{"script":{"type":"string"},"stdin":{"type":"string"}},"required":["script"]}}]"#;

/// One turn's durable event channel: an operator-injection offer raced
/// against the LLM completion child, both submitted to the same named join
/// set (`operator-{turn}`). Unlike JS's `session.completionExecutionId`, the
/// in-flight completion id lives in a local variable in
/// `call_llm_with_operator` (its only reader), not a struct field.
struct Session {
    join_set: JoinSet,
    injection_execution_id: workflow_support::ExecutionId,
}

enum SessionEvent {
    Shell {
        id: String,
        script: String,
        stdin: String,
    },
    Prompt {
        text: String,
    },
}

struct LlmReply {
    content: Vec<Value>,
    request_message_count: usize,
    prompt_queued: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum SessionRecord {
    AgentError(AgentErrorRecord),
    ToolResult(ToolResultRecord),
    ShellOutput(ShellOutputRecord),
}

#[derive(Serialize)]
struct AgentErrorRecord {
    id: String,
    text: String,
    turn_index: u64,
}

#[derive(Serialize)]
struct ToolResultRecord {
    id: String,
    block: ToolResultBlock,
}

#[derive(Clone, Serialize)]
struct ToolResultBlock {
    tool_use_id: String,
    content: String,
    is_error: bool,
}

impl ToolResultBlock {
    fn into_message_value(self) -> Value {
        json!({
            "type": "tool_result",
            "tool_use_id": self.tool_use_id,
            "content": self.content,
            "is_error": self.is_error,
        })
    }
}

#[derive(Clone, Serialize)]
struct ShellOutputRecord {
    id: String,
    script: String,
    result: ShellResult,
}

#[derive(Clone, Serialize)]
struct ShellResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

pub fn agent_loop(
    prompt: String,
    system_prompt: String,
    model: String,
    effort: String,
) -> Result<(), String> {
    if system_prompt.is_empty() {
        return Err("system prompt is required".to_string());
    }

    let mut bash = Bash::new(BashOptions {
        cwd: "/workspace".to_string(),
        // `date` and `sleep` reach the durable Obelisk clock/timer through
        // these seams (a `sleep(now)` read and a `sleep(in(...))` suspend);
        // the interpreter defaults are a fixed epoch and a no-op. Execution
        // limits are not enforced yet anywhere in this interpreter (see
        // design doc), so there is nothing to widen the way JS widens
        // `maxExecutionTimeMs` to infinity.
        now_ms: host_now_ms,
        sleep_ms: host_sleep_ms,
        ..Default::default()
    });
    bash.register_command("obelisk", obelisk_pack::command_handler(Box::new(RealHost)));

    // Configured MCP servers surface as one shell command each; the global `mcp`
    // command is the registry over them. The registry is shared with the servers
    // discovered below (updated between turns on a redeploy) and read at command
    // time, so `mcp` always lists the current set.
    let mcp_registry: obelisk_mcp::ServerRegistry = Rc::new(RefCell::new(Vec::new()));
    bash.register_command(
        "mcp",
        obelisk_mcp::registry_command_handler(mcp_registry.clone(), Box::new(RealHost)),
    );
    // A server whose name would shadow a builtin, the `obelisk`/`mcp` command, or
    // a discovered program is skipped (the reason recorded to `.mcp-error`),
    // mirroring the program/mount error convention.
    let mut reserved: BTreeSet<&str> = just_bash_rs::command_names().into_iter().collect();
    reserved.insert("obelisk");
    reserved.insert("mcp");

    let system = format!(
        "{system_prompt}\n\n# Shell\n\nThe only model-facing tool is bash. Its filesystem persists for this session. Run `help` to list every built-in and discovered program available in the shell.\n{}",
        obelisk_pack::SYSTEM_PROMPT
    );

    let mut messages: Vec<Value> = if !prompt.trim().is_empty() {
        vec![user_text(prompt.trim())]
    } else {
        Vec::new()
    };

    // Shell outputs are stubbed and drained synchronously, so one named set
    // serves the whole session; each turn opens its own operator set below.
    let output_join_set = workflow_support::join_set_create_named("record-output")
        .map_err(|e| format!("record-output join set: {e:?}"))?;

    let mut pack_mounted = false;
    // Program.* shell commands are (re-)registered whenever the active
    // deployment changes, so a redeploy that adds program functions surfaces
    // them as commands mid-session. `programs_registered` forces the first
    // pass even when the deployment-id read is unavailable; `active_deployment_id`
    // gates subsequent re-discovery; `registered_programs` keeps registration
    // idempotent across turns.
    let mut programs_registered = false;
    let mut active_deployment_id: Option<String> = None;
    let mut registered_programs: BTreeSet<String> = Default::default();
    let mut registered_mcp_servers: BTreeSet<String> = Default::default();
    let mut turn_index: u64 = 0;
    let mut should_call_llm = !messages.is_empty();
    let mut agent_steps = 0u32;

    loop {
        if should_call_llm && agent_steps >= MAX_TURNS {
            let message =
                format!("exceeded MAX_TURNS={MAX_TURNS} without yielding an assistant response");
            messages.push(json!({
                "role": "assistant",
                "content": [{"type": "text", "text": message}],
            }));
            publish_session_record(
                &output_join_set,
                &SessionRecord::AgentError(AgentErrorRecord {
                    id: format!("turn-limit-{turn_index}"),
                    text: message,
                    turn_index,
                }),
            )?;
            should_call_llm = false;
            agent_steps = 0;
            turn_index += 1;
            continue;
        }

        // A turn is one operator interaction or one model completion. The name
        // embeds the turn index because a named set's name is reserved for the
        // execution's whole history and cannot be reused across turns.
        let mut session = open_turn(turn_index)?;

        // Re-discover program commands on the first turn and whenever the
        // active deployment changes (a successful redeploy). Both the
        // deployment-id read and discovery are recorded host calls, so replay
        // stays deterministic. Newly deployed program.* functions are added;
        // commands from a prior deployment stay registered (their child call
        // simply fails if the function is gone). Files are left untouched here:
        // the model refreshes sources explicitly with `obelisk deployment
        // refresh`, which would otherwise discard its in-progress edits.
        let current_deployment = current_deployment_id();
        let deployment_changed = match &current_deployment {
            Ok(id) => active_deployment_id.as_deref() != Some(id.as_str()),
            Err(_) => false,
        };
        if !programs_registered || deployment_changed {
            match obelisk_program::discover(&mut RealHost) {
                Ok(programs) => {
                    for program in programs {
                        if registered_programs.insert(program.name.clone()) {
                            bash.register_command(
                                &program.name,
                                obelisk_program::command_handler(
                                    &program.name,
                                    program.ffqn,
                                    Box::new(RealHost),
                                ),
                            );
                        }
                    }
                }
                Err(err) => {
                    let _ = bash
                        .fs_mut()
                        .write_file("/workspace/.program-error", err.as_bytes());
                }
            }
            // MCP servers are discovered the same way as programs (a recorded
            // list-functions call), on the first turn and on every redeploy.
            // Registration is idempotent; a server whose name collides is
            // skipped and the reason recorded.
            match obelisk_mcp::discover(&mut RealHost) {
                Ok(servers) => {
                    let mut skipped: Vec<String> = Vec::new();
                    for server in servers {
                        if registered_mcp_servers.contains(&server.name) {
                            continue;
                        }
                        if reserved.contains(server.name.as_str())
                            || registered_programs.contains(&server.name)
                        {
                            skipped.push(format!(
                                "{}: name shadows a builtin, the obelisk/mcp command, or a program; command not registered",
                                server.name
                            ));
                            continue;
                        }
                        registered_mcp_servers.insert(server.name.clone());
                        mcp_registry.borrow_mut().push(server.clone());
                        bash.register_command(
                            &server.name,
                            obelisk_mcp::server_command_handler(
                                &server.name,
                                &server.ffqn,
                                Box::new(RealHost),
                            ),
                        );
                        let mount_dir = format!("/workspace/mcp/{}", server.name);
                        match obelisk_mcp::mount_resources(
                            bash.fs_mut(),
                            &mut RealHost,
                            Box::new(RealHost),
                            &server.ffqn,
                            &mount_dir,
                        ) {
                            Ok(_) => {}
                            Err(err) => skipped
                                .push(format!("{}: resources not mounted: {err}", server.name)),
                        }
                    }
                    if !skipped.is_empty() {
                        let _ = bash
                            .fs_mut()
                            .write_file("/workspace/.mcp-error", skipped.join("\n").as_bytes());
                    }
                }
                Err(err) => {
                    let _ = bash
                        .fs_mut()
                        .write_file("/workspace/.mcp-error", err.as_bytes());
                }
            }
            programs_registered = true;
            if let Ok(id) = current_deployment {
                active_deployment_id = Some(id);
            }
        }

        if !pack_mounted {
            // Open the input offer (in open_turn) before mounting packs so
            // the UI can identify a live session immediately. Unlike JS,
            // there is no `console.log` to report a mount failure to (see
            // module docs), so a failed mount records the error into the
            // workspace (`/workspace/.mount-error`) instead of leaving an
            // empty workspace with no explanation (see port-findings.md A).
            //
            // Install the lazy blob loader before mounting: `mount` only
            // registers the deployment's file *structure*, so each source is
            // fetched from the CAS by this loader the first time it is read.
            bash.fs_mut()
                .set_blob_loader(obelisk_pack::blob_loader(Box::new(RealHost)));
            if let Err(err) = obelisk_pack::mount(bash.fs_mut(), &mut RealHost) {
                let _ = bash
                    .fs_mut()
                    .write_file("/workspace/.mount-error", err.as_bytes());
            }
            pack_mounted = true;
        }
        if !should_call_llm {
            let text = take_operator_event(&mut session)?;
            let event = parse_session_event(&text);
            should_call_llm =
                apply_session_event(event, &output_join_set, &mut bash, &mut messages)?;
        } else {
            let reply = call_llm_with_operator(
                &mut session,
                &system,
                &mut messages,
                &model,
                &effort,
                &mut bash,
                &output_join_set,
            )?;
            agent_steps += 1;
            messages.insert(
                reply.request_message_count,
                json!({"role": "assistant", "content": reply.content}),
            );

            let calls: Vec<ToolCall> = reply
                .content
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(Value::as_str) != Some("tool_use") {
                        return None;
                    }
                    Some(ToolCall {
                        id: b
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        name: b
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        input: b.get("input").cloned().unwrap_or_else(|| json!({})),
                    })
                })
                .collect();
            if !calls.is_empty() {
                let mut result_blocks = Vec::with_capacity(calls.len());
                for call in &calls {
                    let block = dispatch_bash(call, &mut bash);
                    publish_session_record(
                        &output_join_set,
                        &SessionRecord::ToolResult(ToolResultRecord {
                            id: call.id.clone(),
                            block: block.clone(),
                        }),
                    )?;
                    result_blocks.push(block.into_message_value());
                }
                messages.insert(
                    reply.request_message_count + 1,
                    json!({"role": "user", "content": result_blocks}),
                );
                should_call_llm = true;
            } else {
                should_call_llm = reply.prompt_queued;
                agent_steps = 0;
            }
        }
        // `session.join_set` drops (closes) here at the end of the turn's
        // scope; see module docs.
        turn_index += 1;
    }
}

struct ToolCall {
    id: String,
    name: String,
    input: Value,
}

fn dispatch_bash(call: &ToolCall, bash: &mut Bash) -> ToolResultBlock {
    if call.name != "bash" {
        return tool_error(&call.id, &format!("unknown tool: {}", call.name));
    }
    let script = call
        .input
        .get("script")
        .and_then(Value::as_str)
        .unwrap_or("");
    if script.trim().is_empty() {
        return tool_error(&call.id, "script is required");
    }
    let stdin = call
        .input
        .get("stdin")
        .and_then(Value::as_str)
        .unwrap_or("");
    let result = exec_shell(bash, script, stdin);
    tool_ok(
        &call.id,
        serde_json::to_string(&shell_result(result)).expect("json"),
    )
}

fn apply_session_event(
    event: SessionEvent,
    output_join_set: &JoinSet,
    bash: &mut Bash,
    messages: &mut Vec<Value>,
) -> Result<bool, String> {
    match event {
        SessionEvent::Shell { id, script, stdin } => {
            let result = exec_shell(bash, &script, &stdin);
            let record = ShellOutputRecord {
                id,
                script,
                result: shell_result(result),
            };
            publish_session_record(output_join_set, &SessionRecord::ShellOutput(record.clone()))?;
            append_shell_exchange(messages, &record, &stdin);
            Ok(false)
        }
        SessionEvent::Prompt { text } => {
            messages.push(user_text(&text));
            Ok(true)
        }
    }
}

fn append_shell_exchange(messages: &mut Vec<Value>, record: &ShellOutputRecord, stdin: &str) {
    let mut input = json!({"script": record.script});
    if !stdin.is_empty() {
        input["stdin"] = Value::String(stdin.to_string());
    }
    messages.push(json!({
        "role": "assistant",
        "content": [{"type": "tool_use", "id": record.id, "name": "bash", "input": input}],
    }));
    let result_json = serde_json::to_string(&record.result).expect("json");
    messages.push(json!({
        "role": "user",
        "content": [tool_ok(&record.id, result_json).into_message_value()],
    }));
}

fn publish_session_record(output_join_set: &JoinSet, record: &SessionRecord) -> Result<(), String> {
    let event_id = match record {
        SessionRecord::AgentError(record) => &record.id,
        SessionRecord::ToolResult(record) => &record.id,
        SessionRecord::ShellOutput(record) => &record.id,
    };
    let function = split_ffqn(OUTPUT_FFQN)?;
    let execution_id =
        workflow_support::submit_json(output_join_set, &function, &json!([event_id]).to_string())
            .map_err(|e| format!("{e:?}"))?;
    let stub_payload = json!({"ok": record}).to_string();
    workflow_support::stub_json(&execution_id, &stub_payload).map_err(|e| format!("{e:?}"))?;

    let inner = workflow_support::join_next(output_join_set).map_err(|e| format!("{e:?}"))?;
    let last_id = last_response_execution_id(output_join_set);
    let published: Value = inner
        .map_err(child_error_message)?
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or(Value::Null);
    if last_id.as_deref() != Some(execution_id.id.as_str())
        || published != serde_json::to_value(record).expect("session record must serialize")
    {
        return Err(format!("unexpected session output response: {last_id:?}"));
    }
    Ok(())
}

fn exec_shell(bash: &mut Bash, script: &str, stdin: &str) -> ExecResult {
    if contains_background_statement(script) {
        return ExecResult {
            stdout: String::new(),
            stderr: "bash: background jobs with `&` are not supported in durable sessions\n"
                .to_string(),
            exit_code: 2,
            env: Default::default(),
        };
    }
    bash.exec(
        script,
        ExecOptions {
            stdin: stdin.to_string(),
            cwd: None,
        },
    )
}

/// The exact predicate the session loop uses to reject detached jobs
/// (`Script::has_background`, `ast.rs`); a parse error is not itself a
/// background job, so `just-bash` produces its normal syntax error instead.
fn contains_background_statement(script: &str) -> bool {
    just_bash_rs::parse(script)
        .map(|ast| ast.has_background())
        .unwrap_or(false)
}

fn parse_session_event(text: &str) -> SessionEvent {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        if value.get("kind").and_then(Value::as_str) == Some("shell")
            && let Some(script) = value.get("script").and_then(Value::as_str)
        {
            let id = value
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(random_event_id);
            let stdin = value
                .get("stdin")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            return SessionEvent::Shell {
                id,
                script: script.to_string(),
                stdin,
            };
        }
        if value.get("kind").and_then(Value::as_str) == Some("prompt")
            && let Some(t) = value.get("text").and_then(Value::as_str)
            && !t.trim().is_empty()
        {
            return SessionEvent::Prompt {
                text: t.trim().to_string(),
            };
        }
    }
    SessionEvent::Prompt {
        text: text.trim().to_string(),
    }
}

/// Durable, deterministic fallback event id (JS uses `String(Math.random())`;
/// this WIT provides `random-string` for exactly this purpose).
fn random_event_id() -> String {
    workflow_support::random_string(16, 17)
}

fn shell_result(result: ExecResult) -> ShellResult {
    ShellResult {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
    }
}

/// One LLM call raced against the operator input offer. Each injected event is
/// appended after the request snapshot and therefore reaches the model on the
/// following turn.
#[allow(clippy::too_many_arguments)]
fn call_llm_with_operator(
    session: &mut Session,
    system: &str,
    messages: &mut Vec<Value>,
    model: &str,
    effort: &str,
    bash: &mut Bash,
    output_join_set: &JoinSet,
) -> Result<LlmReply, String> {
    let mut prompt_queued = false;
    loop {
        let request_message_count = messages.len();
        let params = json!([
            system,
            serde_json::to_string(messages).expect("json"),
            BASH_TOOLS_JSON,
            model,
            effort,
        ])
        .to_string();
        let function = split_ffqn(COMPLETION_FFQN)?;
        let completion_execution_id =
            workflow_support::submit_json(&session.join_set, &function, &params)
                .map_err(|e| format!("{e:?}"))?;

        let res: Value = loop {
            let inner =
                workflow_support::join_next(&session.join_set).map_err(|e| format!("{e:?}"))?;
            let completed_id = last_response_execution_id(&session.join_set);
            if completed_id.as_deref() == Some(session.injection_execution_id.id.as_str()) {
                rearm_operator(session)?;
                let json = inner
                    .map_err(child_error_message)?
                    .ok_or_else(|| "injection text must be a non-empty string".to_string())?;
                let decoded: String = serde_json::from_str(&json).unwrap_or(json);
                let event = parse_session_event(&decoded);
                prompt_queued |= apply_session_event(event, output_join_set, bash, messages)?;
                continue;
            }
            if completed_id.as_deref() != Some(completion_execution_id.id.as_str()) {
                return Err(format!("unexpected session response: {completed_id:?}"));
            }
            let value = inner
                .map_err(child_error_message)?
                .ok_or_else(|| "unexpected llm.completion result: no value".to_string())?;
            break serde_json::from_str(&value)
                .map_err(|e| format!("unexpected llm.completion result: {e}"))?;
        };

        if let Some(rate_limited) = res.get("rate_limited") {
            let seconds = rate_limited
                .get("retry_after_seconds")
                .and_then(Value::as_u64)
                .filter(|s| *s > 0)
                .unwrap_or(1);
            workflow_support::sleep(ScheduleAt::In(Duration::Seconds(seconds)), None)
                .map_err(|_| "sleep was cancelled".to_string())?;
            continue;
        }
        if let Some(reply) = res.get("reply") {
            let content_json = reply
                .get("content_json")
                .and_then(Value::as_str)
                .ok_or_else(|| "llm reply content_json is not valid JSON".to_string())?;
            let content: Value = serde_json::from_str(content_json)
                .map_err(|e| format!("llm reply content_json is not valid JSON: {e}"))?;
            let content = content
                .as_array()
                .cloned()
                .ok_or_else(|| "llm reply content must be a JSON array of blocks".to_string())?;
            return Ok(LlmReply {
                content,
                request_message_count,
                prompt_queued,
            });
        }
        return Err(format!("unexpected llm.completion result: {res}"));
    }
}

// ----- messages ---------------------------------------------------------------

fn user_text(text: &str) -> Value {
    json!({"role": "user", "content": [{"type": "text", "text": text}]})
}

fn tool_ok(id: &str, json_string: String) -> ToolResultBlock {
    // The extra `to_string` mirrors JS's `JSON.stringify(s).length`: the
    // encoded-bytes estimate is how large `s` becomes once embedded (quoted,
    // escaped) in the outer `messages-json` payload.
    let encoded_len = serde_json::to_string(&json_string).expect("json").len();
    if encoded_len > MAX_TOOL_RESULT_BYTES {
        return tool_error(
            id,
            &format!(
                "result too large (~{encoded_len} encoded bytes); narrow the request with pagination or a more specific selector"
            ),
        );
    }
    ToolResultBlock {
        tool_use_id: id.to_string(),
        content: json_string,
        is_error: false,
    }
}

fn tool_error(id: &str, message: &str) -> ToolResultBlock {
    ToolResultBlock {
        tool_use_id: id.to_string(),
        content: format!("Error: {message}"),
        is_error: true,
    }
}

// ----- durable session channel ------------------------------------------------

fn open_turn(turn_index: u64) -> Result<Session, String> {
    let join_set = workflow_support::join_set_create_named(&format!("operator-{turn_index}"))
        .map_err(|e| format!("{e:?}"))?;
    let injection_execution_id = submit_no_args(&join_set, INJECTION_FFQN)?;
    Ok(Session {
        join_set,
        injection_execution_id,
    })
}

fn rearm_operator(session: &mut Session) -> Result<(), String> {
    session.injection_execution_id = submit_no_args(&session.join_set, INJECTION_FFQN)?;
    Ok(())
}

fn take_operator_event(session: &mut Session) -> Result<String, String> {
    let inner = workflow_support::join_next(&session.join_set).map_err(|e| format!("{e:?}"))?;
    let completed_id = last_response_execution_id(&session.join_set);
    if completed_id.as_deref() != Some(session.injection_execution_id.id.as_str()) {
        return Err(format!(
            "unexpected session response while idle: {completed_id:?}"
        ));
    }
    let json = inner
        .map_err(child_error_message)?
        .ok_or_else(|| "injection text must be a non-empty string".to_string())?;
    let decoded: String = serde_json::from_str(&json).unwrap_or(json);
    if decoded.trim().is_empty() {
        return Err("injection text must be a non-empty string".to_string());
    }
    rearm_operator(session)?;
    Ok(decoded.trim().to_string())
}

fn submit_no_args(join_set: &JoinSet, ffqn: &str) -> Result<workflow_support::ExecutionId, String> {
    let function = split_ffqn(ffqn)?;
    workflow_support::submit_json(join_set, &function, "[]").map_err(|e| format!("{e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_shell_exchange_is_valid_model_tool_history() {
        let mut messages = vec![user_text("inspect the workspace")];
        let record = ShellOutputRecord {
            id: "shell-17".to_string(),
            script: "cat note.txt".to_string(),
            result: ShellResult {
                stdout: "hello\n".to_string(),
                stderr: String::new(),
                exit_code: 0,
            },
        };

        append_shell_exchange(&mut messages, &record, "input\n");

        assert_eq!(
            messages[1],
            json!({
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "shell-17",
                    "name": "bash",
                    "input": {"script": "cat note.txt", "stdin": "input\n"},
                }],
            })
        );
        assert_eq!(messages[2]["role"], "user");
        let result = &messages[2]["content"][0];
        assert_eq!(result["type"], "tool_result");
        assert_eq!(result["tool_use_id"], "shell-17");
        assert_eq!(result["is_error"], false);
        assert_eq!(
            serde_json::from_str::<Value>(result["content"].as_str().unwrap()).unwrap(),
            serde_json::to_value(&record.result).unwrap()
        );
    }

    #[test]
    fn session_record_uses_wit_variant_shape() {
        let record = SessionRecord::ToolResult(ToolResultRecord {
            id: "tool-1".to_string(),
            block: ToolResultBlock {
                tool_use_id: "tool-1".to_string(),
                content: "ok".to_string(),
                is_error: false,
            },
        });

        assert_eq!(
            serde_json::to_value(record).unwrap(),
            json!({
                "tool_result": {
                    "id": "tool-1",
                    "block": {
                        "tool_use_id": "tool-1",
                        "content": "ok",
                        "is_error": false,
                    },
                },
            })
        );
    }
}
