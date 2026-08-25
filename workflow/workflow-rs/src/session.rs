//! PORT: workflow/agent-loop-src.js
//!
//! The generic session loop: one persistent `Bash` instance, one named
//! `session-events` notification join set and one named `user` join set for
//! the whole session. The latter races each LLM completion child against an
//! always-outstanding user-injection offer. Direct shell
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
//!   closes on `Drop`, so scope exit (a fresh `Session` each loop, and the
//!   session-wide notification join sets falling out of scope when this function
//!   returns) already does the equivalent cleanup.
//! - `WORKFLOW_UNAVAILABLE_COMMANDS` (gzip/gunzip/zcat) has no Rust
//!   equivalent: this port's command catalog (`just_bash_rs::commands`) never
//!   included those commands in the first place, so there is nothing to
//!   filter out of `Bash`'s fixed builtin table.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use serde_json::{Value, json};

use just_bash_rs::{Bash, BashOptions, ExecOptions, ExecResult, Fd, ObeliskHost};
use just_bash_rs::{obelisk_mcp, obelisk_pack, obelisk_program};

use crate::generated::obelisk::types::time::Duration;
use crate::generated::obelisk::workflow::workflow_support::{self, JoinSet, ScheduleAt};
use crate::generated::obelisk_agent::llm::chat::CompletionResult;
use crate::generated::obelisk_agent::llm_obelisk_ext::chat as llm_ext;
use crate::generated::obelisk_agent::stub::stub::{
    AgentErrorEvent, AgentStatusEvent, AssistantReplyEvent, HumanInputRequestedEvent,
    HumanInputResolvedEvent, InputOfferedEvent, OutputChunk, PromptInput, SessionEvent,
    SessionInput, SessionStartedEvent, ShellInput, ShellOutputEvent, ShellResult, ToolOutput,
    ToolResultEvent, UserMessageEvent,
};
use crate::generated::obelisk_agent::stub_obelisk_ext::stub as session_ext;
use crate::generated::obelisk_agent::stub_obelisk_stub::stub as session_stub;
use crate::host::RealHost;
use crate::support::last_response_execution_id;

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

const MAX_TOOL_RESULT_BYTES: usize = 96 * 1024;
const SESSION_EVENTS_JOIN_SET: &str = "session-events";
const CONFIG_DISCOVER_FFQN: &str = "obelisk-agent:config/config.discover";
// Keep in lockstep with `BASH_TOOLS_JSON` in agent-loop-src.js.
const BASH_TOOLS_JSON: &str = r#"[{"name":"bash","description":"Run a Bash script in the session persistent virtual workspace.","input_schema":{"type":"object","properties":{"script":{"type":"string"},"stdin":{"type":"string"}},"required":["script"]}}]"#;

// `concat!` (not `\`-continuation) so each entry keeps its leading two-space
// indent; a `\` line-continuation would strip the continued line's whitespace.
const MOUNT_HEADER: &str = concat!(
    "Network-backed mounts (lazy: a directory lists and a file's bytes fetch on first access):\n",
    "  /workspace/deployment/current  target Obelisk active deployment, editable (one request for its whole file index)\n",
);
const MOUNT_FOOTER: &str = "Avoid tree, find, and recursive grep (grep -r / fgrep -r) across these mounts; use targeted ls and cat.\n";

/// The `mount` shell command: list the session's network-backed mount points and
/// their laziness, so the model sees what is mounted and which trees to avoid
/// recursively scanning. For each discovered MCP server it live-probes the
/// endpoint (a `tools/list` round-trip via the transport activity) and reports
/// whether it is responding, so a not-yet-started server is visible without the
/// model having to open its resource tree.
fn mount_command(
    mcp_servers: Vec<(String, String)>,
    webhook_url: String,
    host: Box<dyn ObeliskHost>,
) -> just_bash_rs::CustomCommandHandler {
    let mut host = host;
    Box::new(
        move |_: &mut just_bash_rs::interpreter::Interpreter, _: &[String], _: String| {
            just_bash_rs::interpreter::CommandOutput {
                stdout: render_mount(&mcp_servers, &webhook_url, host.as_mut()),
                stderr: String::new(),
                exit_code: 0,
            }
        },
    )
}

/// Render the `mount` listing, live-probing each MCP server for reachability.
fn render_mount(
    mcp_servers: &[(String, String)],
    webhook_url: &str,
    host: &mut dyn ObeliskHost,
) -> String {
    let mut text = String::from(MOUNT_HEADER);
    if !webhook_url.is_empty() {
        text.push_str(&format!(
            "  {webhook_url}  target Obelisk webhooks (GET allowed via curl)\n"
        ));
    }
    for (name, ffqn) in mcp_servers {
        let status = match host.call_json(ffqn, "[\"tools/list\",\"{}\"]") {
            Ok(_) => "responding".to_string(),
            Err(err) => format!("not responding: {}", mount_probe_reason(&err)),
        };
        text.push_str(&format!(
            "  /workspace/mcp/{name}  MCP server, read-only ({status})\n"
        ));
    }
    text.push_str(MOUNT_FOOTER);
    text
}

/// Reduce an MCP probe error to a short single-line reason for the `mount`
/// listing (a transport failure is usually a multi-line/verbose message).
fn mount_probe_reason(err: &str) -> String {
    err.lines().next().unwrap_or("").chars().take(80).collect()
}

/// A shell program discovered from the operator-owned `PROGRAMS_JSON` registry:
/// a command `name`, the `ffqn` of its Obelisk program activity, and a one-line
/// `description` the workflow surfaces in the system prompt.
struct Program {
    name: String,
    ffqn: String,
    description: String,
}

struct SessionConfig {
    max_steps: u32,
    programs: Vec<Program>,
    mcp_servers: Vec<(String, String)>,
    /// Base URL of the target's webhook listener; empty when not configured.
    webhook_url: String,
}

/// Load all operator-owned session settings in one activity call so environment
/// changes do not require rebuilding this deterministic workflow component.
fn discover_session_config(host: &mut dyn ObeliskHost) -> Result<SessionConfig, String> {
    let json = host
        .call_json(CONFIG_DISCOVER_FFQN, "[]")?
        .ok_or_else(|| "session config activity returned no value".to_string())?;
    parse_session_config(&json)
}

fn parse_session_config(json: &str) -> Result<SessionConfig, String> {
    let value: Value = serde_json::from_str(json)
        .map_err(|e| format!("session config returned invalid JSON: {e}"))?;
    let max_steps = value
        .get("max_steps")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "session config has invalid max_steps".to_string())?;
    let programs = parse_programs(
        value
            .get("programs")
            .ok_or_else(|| "session config has no programs".to_string())?,
    )?;
    let mcp_servers = parse_mcp_servers(
        value
            .get("mcp_servers")
            .ok_or_else(|| "session config has no mcp_servers".to_string())?,
    )?;
    let webhook_url = value
        .get("webhook_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(SessionConfig {
        max_steps,
        programs,
        mcp_servers,
        webhook_url,
    })
}

fn parse_programs(value: &Value) -> Result<Vec<Program>, String> {
    let entries = value
        .as_array()
        .ok_or_else(|| "session config programs is not an array".to_string())?;
    entries
        .iter()
        .map(|entry| {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| "program entry has no name".to_string())?;
            let ffqn = entry
                .get("ffqn")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("program {name} has no ffqn"))?;
            let description = entry
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            Ok(Program {
                name: name.to_string(),
                ffqn: ffqn.to_string(),
                description: description.to_string(),
            })
        })
        .collect()
}

/// The `# Shell` system-prompt paragraph, listing the discovered programs so the
/// model knows which external commands exist and what each does. With no
/// programs it names none, keeping bash the only advertised tool.
fn render_program_help(programs: &[Program]) -> String {
    let mut text = String::from(
        "The only model-facing tool is bash. Its filesystem persists for this session. \
Run `help` to list every command available in the shell.",
    );
    if programs.is_empty() {
        text.push('\n');
        return text;
    }
    text.push_str(" The workflow registers these external commands:\n");
    for program in programs {
        if program.description.is_empty() {
            text.push_str(&format!("  {}\n", program.name));
        } else {
            text.push_str(&format!("  {}  {}\n", program.name, program.description));
        }
    }
    text
}

fn parse_mcp_servers(value: &Value) -> Result<Vec<(String, String)>, String> {
    let entries = value
        .as_array()
        .ok_or_else(|| "session config mcp_servers is not an array".to_string())?;
    entries
        .iter()
        .map(|entry| {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| "mcp server entry has no name".to_string())?;
            let ffqn = entry
                .get("ffqn")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("mcp server {name} has no ffqn"))?;
            Ok((name.to_string(), ffqn.to_string()))
        })
        .collect()
}

/// The terminal error raised when a turn burns through its step budget without
/// the model yielding a final assistant response.
fn step_limit_error(turn_index: u64, max_steps: u32) -> AgentErrorEvent {
    AgentErrorEvent {
        id: format!("step-limit-{turn_index}"),
        text: format!("exceeded MAX_STEPS={max_steps} without yielding an assistant response"),
        turn_index,
    }
}

fn llm_error_event(turn_index: u64, message: &str) -> AgentErrorEvent {
    AgentErrorEvent {
        id: format!("llm-error-{turn_index}"),
        text: message.to_string(),
        turn_index,
    }
}

const EMPTY_REPLY_NUDGE: &str = "Your previous reply had no message content. Reply to the \
user in Markdown, or call the bash tool to keep working.";

fn empty_reply_error(turn_index: u64) -> AgentErrorEvent {
    AgentErrorEvent {
        id: format!("empty-reply-{turn_index}"),
        text: "model returned an empty response again; ending the turn".to_string(),
        turn_index,
    }
}

/// Whether any block carries non-whitespace text the user can read; thinking-
/// only or tool-only replies do not count.
fn has_user_visible_text(content: &[Value]) -> bool {
    content.iter().any(|block| {
        block.get("type").and_then(Value::as_str) == Some("text")
            && block
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
    })
}

/// The durable input channel: a user-injection offer raced against LLM
/// completion children on the session-wide named `user` join set. Unlike
/// JS's `session.completionExecutionId`, the
/// in-flight completion id lives in a local variable in
/// `call_llm_with_user` (its only reader), not a struct field.
struct Session {
    join_set: JoinSet,
    injection_execution_id: workflow_support::ExecutionId,
    turn_index: u64,
}

struct LlmReply {
    content: Vec<Value>,
    content_json: String,
    duration_milliseconds: u64,
    request_message_count: usize,
    prompt_queued: bool,
}

/// `Failed` is a recoverable LLM provider error (e.g. HTTP 529); a fatal
/// protocol violation is still an `Err` from `call_llm_with_user`.
enum LlmOutcome {
    Reply(LlmReply),
    Failed(String),
}

#[derive(Clone)]
struct ToolResultBlock {
    tool_use_id: String,
    output: ToolOutput,
}

impl ToolResultBlock {
    fn into_message_value(self) -> Value {
        let (content, is_error) = match self.output {
            ToolOutput::Ok(result) => (serde_json::to_string(&result).expect("json"), false),
            ToolOutput::Error(message) => (format!("Error: {message}"), true),
        };
        json!({
            "type": "tool_result",
            "tool_use_id": self.tool_use_id,
            "content": content,
            "is_error": is_error,
        })
    }
}

#[derive(Default)]
struct NotificationJoinSetsState {
    join_sets: BTreeMap<String, JoinSet>,
}

#[derive(Clone, Default)]
pub(crate) struct Notifications {
    state: Rc<RefCell<NotificationJoinSetsState>>,
    turn_index: Rc<RefCell<u64>>,
}

impl Notifications {
    fn notify(&self, join_set_name: &str, event: &SessionEvent) -> Result<(), String> {
        let mut state = self.state.borrow_mut();
        if !state.join_sets.contains_key(join_set_name) {
            let join_set = workflow_support::join_set_create_named(join_set_name)
                .map_err(|e| format!("{join_set_name} join set: {e:?}"))?;
            state.join_sets.insert(join_set_name.to_string(), join_set);
        }
        let join_set = state
            .join_sets
            .get(join_set_name)
            .expect("notification join set must exist");
        let event_id = match event {
            SessionEvent::SessionStarted(_) => "session-started".to_string(),
            SessionEvent::InputOffered(event) => event.execution_id.clone(),
            SessionEvent::AgentStatus(event) => format!("agent-status-{}", event.turn_index),
            SessionEvent::HumanInputRequested(event) => event.execution_id.clone(),
            SessionEvent::HumanInputResolved(event) => event.execution_id.clone(),
            SessionEvent::UserMessage(event) => event.id.clone(),
            SessionEvent::AssistantReply(event) => format!("turn-{}", event.turn_index),
            SessionEvent::AgentError(event) => event.id.clone(),
            SessionEvent::ToolResult(event) => event.id.clone(),
            SessionEvent::ShellOutput(event) => event.id.clone(),
        };
        let execution_id = session_ext::record_output_submit(join_set, &event_id);
        session_stub::record_output_stub(&execution_id, Ok(event)).map_err(|e| format!("{e:?}"))?;
        let published = session_ext::record_output_await_next(join_set)
            .map_err(|e| format!("{e:?}"))?
            .map_err(|e| format!("session event failed: {e}"))?;
        let last_id = last_response_execution_id(join_set);
        if last_id.as_deref() != Some(execution_id.id.as_str()) || published != *event {
            return Err(format!("unexpected session event response: {last_id:?}"));
        }
        Ok(())
    }

    pub(crate) fn set_turn_index(&self, turn_index: u64) {
        *self.turn_index.borrow_mut() = turn_index;
    }

    pub(crate) fn human_input_requested(
        &self,
        execution_id: String,
        question: String,
    ) -> Result<(), String> {
        let turn_index = *self.turn_index.borrow();
        self.notify(
            SESSION_EVENTS_JOIN_SET,
            &SessionEvent::HumanInputRequested(HumanInputRequestedEvent {
                execution_id,
                question,
                turn_index,
            }),
        )
    }

    pub(crate) fn human_input_resolved(&self, execution_id: String) -> Result<(), String> {
        let turn_index = *self.turn_index.borrow();
        self.notify(
            SESSION_EVENTS_JOIN_SET,
            &SessionEvent::HumanInputResolved(HumanInputResolvedEvent {
                execution_id,
                turn_index,
            }),
        )
    }
}

fn elapsed_milliseconds(start: i64, end: i64) -> u64 {
    u64::try_from(end.saturating_sub(start)).unwrap_or_default()
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

    let notifications = Notifications::default();
    let host = || RealHost::new(notifications.clone());
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
    bash.register_command("obelisk", obelisk_pack::command_handler(Box::new(host())));

    let config = discover_session_config(&mut host())?;
    let max_steps = config.max_steps;
    let programs = config.programs;
    let mcp_servers = config.mcp_servers;

    for program in &programs {
        bash.register_command(
            &program.name,
            obelisk_program::command_handler(&program.name, &program.ffqn, Box::new(host())),
        );
    }

    let mcp_registry: obelisk_mcp::ServerRegistry = Rc::new(RefCell::new(
        mcp_servers
            .iter()
            .map(|(name, ffqn)| obelisk_mcp::Server {
                name: name.clone(),
                ffqn: ffqn.clone(),
            })
            .collect(),
    ));
    bash.register_command(
        "mcp",
        obelisk_mcp::registry_command_handler(mcp_registry.clone(), Box::new(host())),
    );
    for (name, ffqn) in &mcp_servers {
        bash.register_command(
            name,
            obelisk_mcp::server_command_handler(name, ffqn, Box::new(host())),
        );
    }
    bash.register_command(
        "mount",
        mount_command(
            mcp_servers.clone(),
            config.webhook_url.clone(),
            Box::new(host()),
        ),
    );

    let shell_help = render_program_help(&programs);
    let system = format!(
        "{system_prompt}\n\n\
# Shell\n\n\
{shell_help}\n\
# User input\n\n\
When you need a user answer before you can continue the current task, run \
`obelisk call obelisk-agent:stub/stub.ask-user '[\"Your question\"]'`. This \
special command publishes the question to the UI, blocks, and returns the \
user's answer so you can continue in the same turn. Use it only when the \
answer is required to proceed. To end the turn with a response or a question \
that does not need an immediate answer, reply in Markdown without a command.\n\n{}",
        obelisk_pack::SYSTEM_PROMPT
    );

    let mut messages: Vec<Value> = if !prompt.trim().is_empty() {
        vec![user_text(prompt.trim())]
    } else {
        Vec::new()
    };

    notifications.notify(
        SESSION_EVENTS_JOIN_SET,
        &SessionEvent::SessionStarted(SessionStartedEvent {
            protocol_version: 6,
            prompt: prompt.clone(),
            backend: model.clone(),
            effort: effort.clone(),
            // The exact system string the LLM receives; the UI surfaces it for
            // inspection.
            system_prompt: system.clone(),
        }),
    )?;

    let mut pack_mounted = false;
    let mut turn_index: u64 = 0;
    // Turn index that already consumed its one empty-reply nudge; MAX means none.
    let mut empty_reply_nudged_turn = u64::MAX;
    let mut should_call_llm = !messages.is_empty();
    let mut agent_steps = 0u32;
    let mut session = open_session(turn_index, &notifications)?;
    publish_agent_status(&notifications, should_call_llm, turn_index)?;

    loop {
        session.turn_index = turn_index;
        notifications.set_turn_index(turn_index);
        if should_call_llm && agent_steps >= max_steps {
            let error = step_limit_error(turn_index, max_steps);
            messages.push(json!({
                "role": "assistant",
                "content": [{"type": "text", "text": error.text.clone()}],
            }));
            notifications.notify(SESSION_EVENTS_JOIN_SET, &SessionEvent::AgentError(error))?;
            should_call_llm = false;
            publish_agent_status(&notifications, false, turn_index)?;
            agent_steps = 0;
            turn_index += 1;
            continue;
        }

        let mut turn_complete = false;
        if !pack_mounted {
            // Open the input offer (in open_session) before mounting packs so
            // the UI can identify a live session immediately.
            //
            // Install the lazy blob loader (cheap, no network), then register
            // the deployment tree as a *deferred* mount: the checkout runs only
            // when the session first references `/workspace/deployment`, so a
            // bash-only session never touches the target. A failed mount records
            // the reason in `/workspace/.mount-error` (there is no `console.log`
            // here; see module docs / port-findings.md A). Each owned source is
            // fetched from the CAS by the blob loader the first time it is read.
            bash.fs_mut()
                .set_blob_loader(obelisk_pack::blob_loader(Box::new(host())));
            obelisk_pack::register_deferred_mount(bash.fs_mut(), Box::new(host()));
            // Each MCP server's resources mount lazily too: registering a
            // deferred mount defers its `resources/list` until the session first
            // touches `/workspace/mcp/<name>`.
            for (name, ffqn) in &mcp_servers {
                obelisk_mcp::register_deferred_mount(
                    bash.fs_mut(),
                    Box::new(host()),
                    Box::new(host()),
                    ffqn,
                    &format!("/workspace/mcp/{name}"),
                );
            }
            pack_mounted = true;
        }
        if !should_call_llm {
            let event = take_user_event(&mut session, &notifications)?;
            should_call_llm = apply_session_input(
                event,
                turn_index,
                true,
                &notifications,
                &mut bash,
                &mut messages,
            )?;
            if should_call_llm {
                publish_agent_status(&notifications, true, turn_index)?;
            }
            turn_complete = !should_call_llm;
        } else {
            publish_agent_status(&notifications, true, turn_index)?;
            let reply = match call_llm_with_user(
                &mut session,
                &system,
                &mut messages,
                &model,
                &effort,
                &mut bash,
                &notifications,
            )? {
                LlmOutcome::Reply(reply) => reply,
                LlmOutcome::Failed(message) => {
                    // Surface the error and drop back to the idle input offer so the shell stays usable.
                    notifications.notify(
                        SESSION_EVENTS_JOIN_SET,
                        &SessionEvent::AgentError(llm_error_event(turn_index, &message)),
                    )?;
                    should_call_llm = false;
                    agent_steps = 0;
                    publish_agent_status(&notifications, false, turn_index)?;
                    turn_index += 1;
                    continue;
                }
            };
            agent_steps += 1;
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
            // A reply with neither a tool call nor visible text would end the
            // turn as an empty bubble: nudge once per turn before giving up.
            let nudge_empty_reply = calls.is_empty()
                && !reply.prompt_queued
                && !has_user_visible_text(&reply.content)
                && empty_reply_nudged_turn != turn_index;
            let assistant_completes_turn =
                calls.is_empty() && !reply.prompt_queued && !nudge_empty_reply;
            notifications.notify(
                SESSION_EVENTS_JOIN_SET,
                &SessionEvent::AssistantReply(AssistantReplyEvent {
                    content_json: reply.content_json.clone(),
                    turn_index,
                    duration_milliseconds: reply.duration_milliseconds,
                    turn_complete: assistant_completes_turn,
                }),
            )?;
            messages.insert(
                reply.request_message_count,
                json!({"role": "assistant", "content": reply.content}),
            );

            if !calls.is_empty() {
                let mut result_blocks = Vec::with_capacity(calls.len());
                for call in &calls {
                    let started_at = host_now_ms();
                    let block = dispatch_bash(call, &mut bash);
                    let duration_milliseconds = elapsed_milliseconds(started_at, host_now_ms());
                    notifications.notify(
                        SESSION_EVENTS_JOIN_SET,
                        &SessionEvent::ToolResult(ToolResultEvent {
                            id: call.id.clone(),
                            output: block.output.clone(),
                            turn_index,
                            duration_milliseconds,
                        }),
                    )?;
                    result_blocks.push(block.into_message_value());
                }
                messages.insert(
                    reply.request_message_count + 1,
                    json!({"role": "user", "content": result_blocks}),
                );
                should_call_llm = true;
            } else if nudge_empty_reply {
                empty_reply_nudged_turn = turn_index;
                messages.insert(
                    reply.request_message_count + 1,
                    user_text(EMPTY_REPLY_NUDGE),
                );
                should_call_llm = true;
            } else {
                if !reply.prompt_queued && !has_user_visible_text(&reply.content) {
                    notifications.notify(
                        SESSION_EVENTS_JOIN_SET,
                        &SessionEvent::AgentError(empty_reply_error(turn_index)),
                    )?;
                }
                should_call_llm = reply.prompt_queued;
                agent_steps = 0;
                turn_complete = assistant_completes_turn;
                if !should_call_llm {
                    publish_agent_status(&notifications, false, turn_index)?;
                }
            }
        }
        if turn_complete {
            turn_index += 1;
        }
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
    tool_ok(&call.id, shell_result(result))
}

fn apply_session_input(
    event: SessionInput,
    turn_index: u64,
    shell_completes_turn: bool,
    notifications: &Notifications,
    bash: &mut Bash,
    messages: &mut Vec<Value>,
) -> Result<bool, String> {
    match event {
        SessionInput::Shell(ShellInput { id, script, stdin }) => {
            // One durable record per command (like the model-driven tool path):
            // `shell-output` carries the script and result, so the webui echoes
            // the command and shows its output from this single event.
            let started_at = host_now_ms();
            let result = exec_shell(bash, &script, &stdin);
            let duration_milliseconds = elapsed_milliseconds(started_at, host_now_ms());
            let record = ShellOutputEvent {
                id,
                script,
                result: shell_result(result),
                turn_index,
                duration_milliseconds,
                turn_complete: shell_completes_turn,
            };
            notifications.notify(
                SESSION_EVENTS_JOIN_SET,
                &SessionEvent::ShellOutput(record.clone()),
            )?;
            append_shell_exchange(messages, &record, &stdin);
            Ok(false)
        }
        SessionInput::Prompt(PromptInput { id, text }) => {
            notifications.notify(
                SESSION_EVENTS_JOIN_SET,
                &SessionEvent::UserMessage(UserMessageEvent {
                    id,
                    text: text.clone(),
                    turn_index,
                }),
            )?;
            messages.push(user_text(&text));
            Ok(true)
        }
    }
}

fn append_shell_exchange(messages: &mut Vec<Value>, record: &ShellOutputEvent, stdin: &str) {
    let mut input = json!({"script": record.script});
    if !stdin.is_empty() {
        input["stdin"] = Value::String(stdin.to_string());
    }
    messages.push(json!({
        "role": "assistant",
        "content": [{"type": "tool_use", "id": record.id, "name": "bash", "input": input}],
    }));
    messages.push(json!({
        "role": "user",
        "content": [tool_ok(&record.id, record.result.clone()).into_message_value()],
    }));
}

fn exec_shell(bash: &mut Bash, script: &str, stdin: &str) -> ExecResult {
    if contains_background_statement(script) {
        let message = "bash: background jobs with `&` are not supported in durable sessions\n";
        return ExecResult {
            output: vec![just_bash_rs::OutputChunk {
                fd: Fd::Stderr,
                text: message.to_string(),
            }],
            stderr: message.to_string(),
            stdout: String::new(),
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

fn shell_result(result: ExecResult) -> ShellResult {
    ShellResult {
        output: result
            .output
            .into_iter()
            .map(|chunk| match chunk.fd {
                Fd::Stdout => OutputChunk::Stdout(chunk.text),
                Fd::Stderr => OutputChunk::Stderr(chunk.text),
            })
            .collect(),
        exit_code: result.exit_code,
    }
}

/// One LLM call raced against the user input offer. Each injected event is
/// appended after the request snapshot and therefore reaches the model on the
/// following turn.
#[allow(clippy::too_many_arguments)]
fn call_llm_with_user(
    session: &mut Session,
    system: &str,
    messages: &mut Vec<Value>,
    model: &str,
    effort: &str,
    bash: &mut Bash,
    notifications: &Notifications,
) -> Result<LlmOutcome, String> {
    let mut prompt_queued = false;
    loop {
        let request_message_count = messages.len();
        let messages_json = serde_json::to_string(messages).expect("json");
        let started_at = host_now_ms();
        let completion_execution_id = llm_ext::completion_submit(
            &session.join_set,
            system,
            &messages_json,
            BASH_TOOLS_JSON,
            model,
            effort,
        );

        let res = loop {
            // The `user` join set is heterogeneous (completion child + injection
            // offer), so await generically and dispatch on the completed id read
            // from `last-id`, then fetch the typed value with the matching `-get`.
            // A typed `-await-next` here would mark the next response processed
            // even on a function mismatch, consuming the wrong child.
            let _ = workflow_support::join_next(&session.join_set).map_err(|e| format!("{e:?}"))?;
            let completed_id = last_response_execution_id(&session.join_set)
                .expect("user join set has only child executions, never delays");
            if completed_id == completion_execution_id.id {
                match llm_ext::completion_get(&completion_execution_id)
                    .map_err(|e| format!("{e:?}"))?
                {
                    Ok(completion) => break completion,
                    Err(e) => return Ok(LlmOutcome::Failed(format!("llm.completion failed: {e}"))),
                }
            } else if completed_id == session.injection_execution_id.id {
                let event = session_ext::injection_get(&session.injection_execution_id)
                    .map_err(|e| format!("{e:?}"))?
                    .map_err(|e| format!("session injection failed: {e}"))?;
                rearm_user_input(session, notifications)?;
                prompt_queued |= apply_session_input(
                    event,
                    session.turn_index,
                    false,
                    notifications,
                    bash,
                    messages,
                )?;
            } else {
                return Err(format!("unexpected session response: {completed_id}"));
            }
        };

        match res {
            CompletionResult::RateLimited(rate_limited) => {
                let seconds = u64::from(rate_limited.retry_after_seconds.max(1));
                workflow_support::sleep(ScheduleAt::In(Duration::Seconds(seconds)), None)
                    .map_err(|_| "sleep was cancelled".to_string())?;
            }
            CompletionResult::Reply(reply) => {
                let content: Value = serde_json::from_str(&reply.content_json)
                    .map_err(|e| format!("llm reply content_json is not valid JSON: {e}"))?;
                let content = content.as_array().cloned().ok_or_else(|| {
                    "llm reply content must be a JSON array of blocks".to_string()
                })?;
                return Ok(LlmOutcome::Reply(LlmReply {
                    content,
                    content_json: reply.content_json,
                    duration_milliseconds: elapsed_milliseconds(started_at, host_now_ms()),
                    request_message_count,
                    prompt_queued,
                }));
            }
        }
    }
}

// ----- messages ---------------------------------------------------------------

fn user_text(text: &str) -> Value {
    json!({"role": "user", "content": [{"type": "text", "text": text}]})
}

fn tool_ok(id: &str, result: ShellResult) -> ToolResultBlock {
    let json_string = serde_json::to_string(&result).expect("json");
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
        output: ToolOutput::Ok(result),
    }
}

fn tool_error(id: &str, message: &str) -> ToolResultBlock {
    ToolResultBlock {
        tool_use_id: id.to_string(),
        output: ToolOutput::Error(message.to_string()),
    }
}

// ----- durable session channel ------------------------------------------------

fn open_session(turn_index: u64, notifications: &Notifications) -> Result<Session, String> {
    let join_set = workflow_support::join_set_create_named("user").map_err(|e| format!("{e:?}"))?;
    let injection_execution_id = session_ext::injection_submit(&join_set);
    publish_input_offer(notifications, &injection_execution_id, turn_index)?;
    Ok(Session {
        join_set,
        injection_execution_id,
        turn_index,
    })
}

fn rearm_user_input(session: &mut Session, notifications: &Notifications) -> Result<(), String> {
    session.injection_execution_id = session_ext::injection_submit(&session.join_set);
    publish_input_offer(
        notifications,
        &session.injection_execution_id,
        session.turn_index,
    )
}

fn publish_input_offer(
    notifications: &Notifications,
    execution_id: &workflow_support::ExecutionId,
    turn_index: u64,
) -> Result<(), String> {
    notifications.notify(
        SESSION_EVENTS_JOIN_SET,
        &SessionEvent::InputOffered(InputOfferedEvent {
            execution_id: execution_id.id.clone(),
            turn_index,
        }),
    )
}

fn publish_agent_status(
    notifications: &Notifications,
    working: bool,
    turn_index: u64,
) -> Result<(), String> {
    notifications.notify(
        SESSION_EVENTS_JOIN_SET,
        &SessionEvent::AgentStatus(AgentStatusEvent {
            working,
            turn_index,
        }),
    )
}

fn take_user_event(
    session: &mut Session,
    notifications: &Notifications,
) -> Result<SessionInput, String> {
    // Same heterogeneous-join-set discipline as `call_llm_with_user`: await
    // generically, confirm the completed id is the outstanding injection offer,
    // then fetch its typed value with `injection-get`.
    let _ = workflow_support::join_next(&session.join_set).map_err(|e| format!("{e:?}"))?;
    let completed_id = last_response_execution_id(&session.join_set)
        .expect("user join set has only child executions, never delays");
    if completed_id != session.injection_execution_id.id {
        return Err(format!(
            "unexpected session response while idle: {completed_id}"
        ));
    }
    let event = session_ext::injection_get(&session.injection_execution_id)
        .map_err(|e| format!("{e:?}"))?
        .map_err(|e| format!("session injection failed: {e}"))?;
    rearm_user_input(session, notifications)?;
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mcp_servers_reads_name_and_ffqn() {
        let servers = parse_mcp_servers(&json!([{"name":"a","ffqn":"ns:mcp/server.a"}])).unwrap();
        assert_eq!(
            servers,
            vec![("a".to_string(), "ns:mcp/server.a".to_string())]
        );
        assert!(parse_mcp_servers(&json!([])).unwrap().is_empty());
    }

    #[test]
    fn parse_mcp_servers_rejects_bad_shapes() {
        assert!(parse_mcp_servers(&json!({"name":"a"})).is_err());
        assert!(parse_mcp_servers(&json!([{"ffqn":"x"}])).is_err());
        assert!(parse_mcp_servers(&json!([{"name":"a"}])).is_err());
    }

    #[test]
    fn parse_programs_reads_name_ffqn_and_description() {
        let programs = parse_programs(&json!([
            {"name":"curl","ffqn":"ns:programs/program.curl","description":"GET-only HTTP client"}
        ]))
        .unwrap();
        assert_eq!(programs.len(), 1);
        assert_eq!(programs[0].name, "curl");
        assert_eq!(programs[0].ffqn, "ns:programs/program.curl");
        assert_eq!(programs[0].description, "GET-only HTTP client");
        // description is optional, defaulting to empty.
        let bare = parse_programs(&json!([
            {"name":"curl","ffqn":"ns:programs/program.curl"}
        ]))
        .unwrap();
        assert_eq!(bare[0].description, "");
        assert!(parse_programs(&json!([])).unwrap().is_empty());
    }

    #[test]
    fn parse_programs_rejects_bad_shapes() {
        assert!(parse_programs(&json!({"name":"curl"})).is_err());
        assert!(parse_programs(&json!([{"ffqn":"x"}])).is_err());
        assert!(parse_programs(&json!([{"name":"curl"}])).is_err());
    }

    #[test]
    fn parse_session_config_reads_step_limit_and_registries() {
        let config = parse_session_config(
            r#"{"max_steps":25,"programs":[],"mcp_servers":[],"webhook_url":"http://x:9290"}"#,
        )
        .unwrap();
        assert_eq!(config.max_steps, 25);
        assert!(config.programs.is_empty());
        assert!(config.mcp_servers.is_empty());
        assert_eq!(config.webhook_url, "http://x:9290");

        // webhook_url is optional and defaults to empty.
        let bare =
            parse_session_config(r#"{"max_steps":25,"programs":[],"mcp_servers":[]}"#).unwrap();
        assert_eq!(bare.webhook_url, "");

        assert!(parse_session_config(r#"{"max_steps":0,"programs":[],"mcp_servers":[]}"#).is_err());
        assert!(parse_session_config(r#"{"max_steps":10,"programs":[]}"#).is_err());
    }

    #[test]
    fn has_user_visible_text_ignores_blank_thinking_and_tool_blocks() {
        let blocks = |v: Value| v.as_array().unwrap().clone();
        assert!(!has_user_visible_text(&[]));
        assert!(!has_user_visible_text(&blocks(json!([
            {"type": "thinking", "thinking": "hmm"},
            {"type": "tool_use", "id": "t", "name": "bash", "input": {}}
        ]))));
        assert!(!has_user_visible_text(&blocks(json!([
            {"type": "text", "text": "  \n"}
        ]))));
        assert!(has_user_visible_text(&blocks(json!([
            {"type": "text", "text": "done"}
        ]))));
    }

    #[test]
    fn program_help_lists_discovered_commands() {
        let programs = vec![
            Program {
                name: "curl".to_string(),
                ffqn: "ns:programs/program.curl".to_string(),
                description: "GET-only HTTP client".to_string(),
            },
            Program {
                name: "jq".to_string(),
                ffqn: "ns:programs/program.jq".to_string(),
                description: String::new(),
            },
        ];
        let help = render_program_help(&programs);
        assert!(
            help.contains("registers these external commands:"),
            "{help}"
        );
        assert!(help.contains("\n  curl  GET-only HTTP client\n"), "{help}");
        // A program without a description is listed by name alone.
        assert!(help.contains("\n  jq\n"), "{help}");
        // With no programs, bash is the only advertised tool.
        let none = render_program_help(&[]);
        assert!(!none.contains("external commands"), "{none}");
        assert!(none.contains("bash"), "{none}");
    }

    #[test]
    fn mount_reports_mcp_reachability() {
        struct FakeHost(BTreeMap<String, Result<Option<String>, String>>);
        impl ObeliskHost for FakeHost {
            fn call_json(&mut self, ffqn: &str, _: &str) -> Result<Option<String>, String> {
                self.0
                    .get(ffqn)
                    .cloned()
                    .unwrap_or_else(|| Err("no fixture".to_string()))
            }
        }
        let mut host = FakeHost(BTreeMap::from([
            ("ns:mcp/server.up".to_string(), Ok(Some("[]".to_string()))),
            (
                "ns:mcp/server.down".to_string(),
                Err("connection refused\ntrace line".to_string()),
            ),
        ]));
        let servers = vec![
            ("up".to_string(), "ns:mcp/server.up".to_string()),
            ("down".to_string(), "ns:mcp/server.down".to_string()),
        ];
        let out = render_mount(&servers, "http://127.0.0.1:9290", &mut host);
        // Every entry (header, webhook URL, MCP) is indented two spaces consistently.
        assert!(out.contains("\n  /workspace/deployment/current  "), "{out}");
        assert!(
            out.contains("\n  http://127.0.0.1:9290  target Obelisk webhooks"),
            "{out}"
        );
        assert!(out.contains("\n  /workspace/mcp/up  "), "{out}");
        // An empty webhook URL omits the line instead of rendering a blank entry.
        let bare = render_mount(&servers, "", &mut host);
        assert!(!bare.contains("webhook"), "{bare}");
        assert!(
            out.contains("/workspace/mcp/up  MCP server, read-only (responding)"),
            "{out}"
        );
        assert!(
            out.contains(
                "/workspace/mcp/down  MCP server, read-only (not responding: connection refused)"
            ),
            "{out}"
        );
        // Only the first line of a multi-line error is shown.
        assert!(!out.contains("trace line"), "{out}");
    }

    #[test]
    fn direct_shell_exchange_is_valid_model_tool_history() {
        let mut messages = vec![user_text("inspect the workspace")];
        let record = ShellOutputEvent {
            id: "shell-17".to_string(),
            script: "cat note.txt".to_string(),
            result: ShellResult {
                output: vec![OutputChunk::Stdout("hello\n".to_string())],
                exit_code: 0,
            },
            turn_index: 3,
            duration_milliseconds: 12,
            turn_complete: true,
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
    fn step_limit_error_names_the_step_budget() {
        let error = step_limit_error(2, 25);
        assert_eq!(error.id, "step-limit-2");
        assert_eq!(
            error.text,
            "exceeded MAX_STEPS=25 without yielding an assistant response"
        );
        assert_eq!(error.turn_index, 2);
    }

    #[test]
    fn session_event_uses_wit_variant_shape() {
        let record = SessionEvent::ToolResult(ToolResultEvent {
            id: "tool-1".to_string(),
            output: ToolOutput::Ok(ShellResult {
                output: vec![OutputChunk::Stdout("ok".to_string())],
                exit_code: 0,
            }),
            turn_index: 4,
            duration_milliseconds: 25,
        });

        assert_eq!(
            serde_json::to_value(record).unwrap(),
            json!({
                "tool_result": {
                    "id": "tool-1",
                    "output": {
                        "ok": {
                            "output": [{"stdout": "ok"}],
                            "exit_code": 0,
                        },
                    },
                    "turn_index": 4,
                    "duration_milliseconds": 25,
                },
            })
        );

        let offer = SessionEvent::InputOffered(InputOfferedEvent {
            execution_id: "E_session.4".to_string(),
            turn_index: 5,
        });
        assert_eq!(
            serde_json::to_value(offer).unwrap(),
            json!({
                "input_offered": {
                    "execution_id": "E_session.4",
                    "turn_index": 5,
                },
            })
        );

        let status = SessionEvent::AgentStatus(AgentStatusEvent {
            working: true,
            turn_index: 5,
        });
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({
                "agent_status": {
                    "working": true,
                    "turn_index": 5,
                },
            })
        );

        let requested = SessionEvent::HumanInputRequested(HumanInputRequestedEvent {
            execution_id: "E_session.ask".to_string(),
            question: "Continue?".to_string(),
            turn_index: 5,
        });
        assert_eq!(
            serde_json::to_value(requested).unwrap(),
            json!({
                "human_input_requested": {
                    "execution_id": "E_session.ask",
                    "question": "Continue?",
                    "turn_index": 5,
                },
            })
        );

        let resolved = SessionEvent::HumanInputResolved(HumanInputResolvedEvent {
            execution_id: "E_session.ask".to_string(),
            turn_index: 5,
        });
        assert_eq!(
            serde_json::to_value(resolved).unwrap(),
            json!({
                "human_input_resolved": {
                    "execution_id": "E_session.ask",
                    "turn_index": 5,
                },
            })
        );
    }
}
