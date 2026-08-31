//! Caller-aware subcommands of the `chat` shell program. The activity behind
//! `chat` speaks HTTP to this Obelisk instance but cannot know which session
//! invoked it, nor schedule child executions; the session loop wraps that
//! program's generic handler and intercepts what only a session can answer:
//! `current` (identity), `rename` (slug), and `create` (child scheduling by
//! default). Everything else delegates to the activity unchanged.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use serde_json::{Value, json};

use just_bash_rs::CustomCommandHandler;
use just_bash_rs::interpreter::{CommandOutput, Interpreter};

use crate::generated::obelisk::types::time::Duration;
use crate::generated::obelisk::workflow::workflow_support::{self, JoinSet, ScheduleAt};
use crate::generated::obelisk_agent::workflow_obelisk_ext::workflow as workflow_ext;
use crate::session::Notifications;

pub(crate) const CHAT_PROGRAM_FFQN: &str = "obelisk-agent:programs/program.chat";

const DEFAULT_PEERS_JOIN_SET: &str = "peers";
const MAX_SLUG_LEN: usize = 64;
const EFFORTS: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/// States `chat watch` wakes on: the child stopped progressing on its own or
/// needs its owner. A queued child (`awaiting-user`, nothing done yet) and a
/// busy one deliberately do not wake.
const WATCH_WAKE_STATES: [&str; 7] = [
    "final-response",
    "step-limit",
    "awaiting-answer",
    "shell-only",
    "finished-ok",
    "cancelled",
    "failed",
];
const WATCH_DEFAULT_INTERVAL_MS: u64 = 2_000;
const WATCH_DEFAULT_TIMEOUT_MS: u64 = 15 * 60_000;

/// Live identity of the invoking session, captured where commands are
/// registered (the activity cannot learn its caller).
#[derive(Clone)]
pub(crate) struct ChatSelf {
    execution_id: String,
    backend: String,
    effort: String,
    name: Rc<RefCell<Option<String>>>,
    /// Join sets holding the sessions created by `chat create`, keyed by slug
    /// (`--name` labels each child with its own join set, so its execution id
    /// shows what it is); created lazily on first use and closed when the
    /// session ends, cancelling outstanding children.
    peers: Rc<RefCell<BTreeMap<String, JoinSet>>>,
}

impl ChatSelf {
    pub(crate) fn new(
        execution_id: String,
        backend: String,
        effort: String,
        name: Option<String>,
    ) -> Self {
        Self {
            execution_id,
            backend,
            effort,
            name: Rc::new(RefCell::new(name)),
            peers: Rc::new(RefCell::new(BTreeMap::new())),
        }
    }

    /// The session that created this one, if any. Derived executions carry
    /// their parent in the id (`<parent-id>.<join-set-ref>`).
    pub(crate) fn parent_id(&self) -> Option<String> {
        parent_of(&self.execution_id)
    }
}

/// The session that created an execution, derived from the derived-execution
/// id shape; None for top-level executions.
pub(crate) fn parent_of(execution_id: &str) -> Option<String> {
    execution_id
        .rsplit_once('.')
        .map(|(parent, _)| parent.to_string())
}

pub(crate) fn command_handler(
    delegate: CustomCommandHandler,
    own: ChatSelf,
    notifications: Notifications,
) -> CustomCommandHandler {
    let mut delegate = delegate;
    Box::new(move |interp, args, stdin| match args.split_first() {
        Some((sub, rest)) if sub == "current" && !has_help_flag(rest) => current_output(&own),
        Some((sub, _)) if sub == "rename" && !has_help_flag(args) => {
            rename(args, &own, &notifications)
        }
        Some((sub, rest))
            if sub == "create"
                && !has_help_flag(rest)
                && !rest.iter().any(|arg| arg == "--top-level") =>
        {
            create_child(&own, rest, &mut delegate, interp)
        }
        Some((sub, rest)) if sub == "watch" && !has_help_flag(args) => {
            watch_command(&mut delegate, interp, rest)
        }
        _ => delegate(interp, args, stdin),
    })
}

fn current_payload(own: &ChatSelf) -> serde_json::Value {
    serde_json::json!({
        "execution_id": own.execution_id,
        "backend": own.backend,
        "effort": own.effort,
        "name": own.name.borrow().clone(),
        "parent_id": own.parent_id(),
    })
}

fn current_output(own: &ChatSelf) -> CommandOutput {
    let payload = current_payload(own);
    CommandOutput {
        stdout: format!("{payload}\n"),
        stderr: String::new(),
        exit_code: 0,
    }
}

/// The `# This session` system-prompt paragraph: the session's own identity
/// (exactly what `chat current` prints), its parent for context gathering,
/// and when to rename itself.
pub(crate) fn self_section(own: &ChatSelf) -> String {
    let payload = current_payload(own);
    let mut text = format!(
        "# This session\n\n\
`chat current` output for the session you are running in:\n{payload}\n\n\
Peers discover sessions by slug via `chat list`; read your own transcript \
with `chat read {}`. If your starting prompt already makes the task clear, \
rename yourself first, before anything else (`chat rename <slug>`); \
otherwise wait until the task settles into something nameable. Rename once \
to a short kebab slug summarizing the task; do not rename repeatedly or \
preemptively while it is still unclear.\n",
        own.execution_id
    );
    if let Some(parent) = own.parent_id() {
        text.push_str(&format!(
            "\nYou were started as a child session by {parent}. If your prompt \
leaves you short of context, run `chat read {parent}` to see the transcript \
that created you.\n"
        ));
    }
    text
}

fn rename(args: &[String], own: &ChatSelf, notifications: &Notifications) -> CommandOutput {
    let Some(name) = args.get(1) else {
        return usage("rename expects a slug name");
    };
    if args.len() > 2 {
        return usage("rename takes exactly one argument");
    }
    if let Err(error) = validate_slug(name) {
        return usage(&error);
    }
    match notifications.session_renamed(name.clone()) {
        Ok(()) => {
            *own.name.borrow_mut() = Some(name.clone());
            CommandOutput {
                stdout: format!("renamed to {name}\n"),
                stderr: String::new(),
                exit_code: 0,
            }
        }
        Err(error) => failure(&error),
    }
}

fn create_child(
    own: &ChatSelf,
    args: &[String],
    delegate: &mut CustomCommandHandler,
    interp: &mut Interpreter,
) -> CommandOutput {
    let parsed = match parse_create_args(args) {
        Ok(parsed) => parsed,
        Err(error) => return usage(&error),
    };
    // A true derived child on a session-owned join set: it shows up under
    // --show-derived listings and is cancelled when this session ends. A named
    // child gets its own join set so its execution id carries the slug.
    let set_name = match &parsed.name {
        Some(name) => name,
        None => DEFAULT_PEERS_JOIN_SET,
    };
    let execution_id = {
        let mut peers = own.peers.borrow_mut();
        if !peers.contains_key(set_name) {
            match workflow_support::join_set_create_named(set_name) {
                Ok(join_set) => {
                    peers.insert(set_name.to_string(), join_set);
                }
                Err(error) => return failure(&format!("child join set: {error:?}")),
            }
        }
        // The map keeps sole ownership of every handle; the submit only
        // borrows, since a dropped duplicate would close the join set.
        let join_set = peers.get(set_name).expect("join set just ensured");
        workflow_ext::run_cancellable_submit(
            join_set,
            &parsed.prompt,
            parsed.model.as_deref(),
            None,
            parsed.effort.as_deref(),
            parsed.name.as_deref(),
        )
    };
    if !parsed.watch {
        return CommandOutput {
            stdout: format!("{}\n", execution_id.id),
            stderr: String::new(),
            exit_code: 0,
        };
    }
    watch_loop(
        delegate,
        interp,
        &WatchArgs {
            id: execution_id.id,
            timeout_ms: WATCH_DEFAULT_TIMEOUT_MS,
            interval_ms: WATCH_DEFAULT_INTERVAL_MS,
        },
    )
}

struct CreateArgs {
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    name: Option<String>,
    watch: bool,
}

// Mirrors the activity-side create parser for the flags that matter to child
// scheduling; --top-level never reaches here.
fn parse_create_args(args: &[String]) -> Result<CreateArgs, String> {
    let mut positional = Vec::new();
    let mut model = None;
    let mut effort = None;
    let mut name = None;
    let mut watch = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let (flag, value) = match arg.split_once('=') {
            Some((flag, value)) => (flag.to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        match flag.as_str() {
            "--model" | "--effort" | "--name" => {
                let already = match flag.as_str() {
                    "--model" => model.is_some(),
                    "--effort" => effort.is_some(),
                    _ => name.is_some(),
                };
                if already {
                    return Err(format!("duplicate option: {flag}"));
                }
                let value = match value {
                    Some(value) => value,
                    None => {
                        i += 1;
                        args.get(i)
                            .cloned()
                            .ok_or(format!("option requires a value: {flag}"))?
                    }
                };
                if value.is_empty() {
                    return Err(format!("option requires a non-empty value: {flag}"));
                }
                match flag.as_str() {
                    "--model" => model = Some(value),
                    "--name" => {
                        if let Err(error) = validate_slug(&value) {
                            return Err(format!("--name: {error}"));
                        }
                        name = Some(value);
                    }
                    _ => {
                        if !EFFORTS.contains(&value.as_str()) {
                            return Err(format!("--effort must be one of: {}", EFFORTS.join("|")));
                        }
                        effort = Some(value);
                    }
                }
            }
            "--watch" => watch = true,
            _ if arg.starts_with('-') => return Err(format!("unsupported option: {arg}")),
            _ => positional.push(arg.clone()),
        }
        i += 1;
    }
    Ok(CreateArgs {
        prompt: positional.join(" "),
        model,
        effort,
        name,
        watch,
    })
}

// ----- chat watch ----------------------------------------------------------

struct WatchArgs {
    id: String,
    timeout_ms: u64,
    interval_ms: u64,
}

fn watch_command(
    delegate: &mut CustomCommandHandler,
    interp: &mut Interpreter,
    args: &[String],
) -> CommandOutput {
    let parsed = match parse_watch_args(args) {
        Ok(parsed) => parsed,
        Err(error) => return usage(&error),
    };
    watch_loop(delegate, interp, &parsed)
}

/// Poll `chat state` for one session until it reports a wake state or the
/// timeout elapses. Each poll is a durable activity call and each wait a
/// durable sleep, so the whole loop survives restarts and pause.
fn watch_loop(
    delegate: &mut CustomCommandHandler,
    interp: &mut Interpreter,
    parsed: &WatchArgs,
) -> CommandOutput {
    let started_ms = now_ms();
    let deadline = started_ms.saturating_add(parsed.timeout_ms);
    let mut stderr_notes = String::new();
    let mut last_payload: Option<String> = None;
    loop {
        let state_args = ["state".to_string(), parsed.id.clone()];
        let out = delegate(interp, &state_args, String::new());
        if out.exit_code == 0
            && let Ok(mut payload) = serde_json::from_str::<Value>(out.stdout.trim())
        {
            let state = payload
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if WATCH_WAKE_STATES.contains(&state) {
                stamp_watch_fields(&mut payload, false, now_ms().saturating_sub(started_ms));
                attach_final(delegate, interp, &parsed.id, &mut payload);
                return CommandOutput {
                    stdout: format!("{payload}\n"),
                    stderr: stderr_notes,
                    exit_code: 0,
                };
            }
            last_payload = Some(out.stdout.trim().to_string());
        } else {
            stderr_notes.push_str(&format!("chat watch: state read failed: {}", out.stderr));
        }
        let now = now_ms();
        if now >= deadline {
            break;
        }
        workflow_support::sleep(
            ScheduleAt::In(Duration::Milliseconds(
                parsed.interval_ms.min(deadline - now),
            )),
            None,
        )
        .map_err(|error| format!("watch sleep: {error:?}"))
        .expect("durable sleep failed");
    }
    let waited = now_ms().saturating_sub(started_ms);
    let mut payload: Value =
        serde_json::from_str(last_payload.as_deref().unwrap_or("{}")).unwrap_or_else(|_| json!({}));
    stamp_watch_fields(&mut payload, true, waited);
    attach_final(delegate, interp, &parsed.id, &mut payload);
    stderr_notes.push_str(&format!(
        "chat watch: gave up after {} ms waiting for {}{}\n",
        waited,
        parsed.id,
        payload
            .get("state")
            .and_then(Value::as_str)
            .map(|state| format!(" (state: {state})"))
            .unwrap_or_default(),
    ));
    CommandOutput {
        stdout: format!("{payload}\n"),
        stderr: stderr_notes,
        exit_code: 1,
    }
}

/// Adds the `final` field: the same outcome text `chat read ID --final`
/// prints (finished reply, error/failure reason, or pending question), so a
/// caller does not need a second round trip after `watch` wakes. Best effort:
/// a failed read leaves `final` absent rather than failing the whole watch.
fn attach_final(
    delegate: &mut CustomCommandHandler,
    interp: &mut Interpreter,
    id: &str,
    payload: &mut Value,
) {
    let out = delegate(
        interp,
        &["read".to_string(), id.to_string(), "--final".to_string()],
        String::new(),
    );
    if out.exit_code == 0
        && let Some(object) = payload.as_object_mut()
    {
        object.insert("final".to_string(), json!(out.stdout.trim()));
    }
}

fn stamp_watch_fields(payload: &mut Value, timed_out: bool, waited_ms: u64) {
    if !payload.is_object() {
        *payload = json!({});
    }
    let object = payload.as_object_mut().expect("just checked");
    object.insert("timed_out".to_string(), json!(timed_out));
    object.insert("waited_ms".to_string(), json!(waited_ms));
}

fn parse_watch_args(args: &[String]) -> Result<WatchArgs, String> {
    let mut id: Option<String> = None;
    let mut timeout_ms = WATCH_DEFAULT_TIMEOUT_MS;
    let mut interval_ms = WATCH_DEFAULT_INTERVAL_MS;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let (flag, inline_value) = match arg.split_once('=') {
            Some((flag, value)) => (flag.to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        let take_value = |i: &mut usize| -> Result<String, String> {
            if let Some(value) = inline_value {
                return Ok(value);
            }
            *i += 1;
            args.get(*i)
                .cloned()
                .filter(|value| !value.is_empty())
                .ok_or(format!("option requires a value: {flag}"))
        };
        match flag.as_str() {
            "--timeout" => timeout_ms = parse_duration_ms(&take_value(&mut i)?)?,
            "--interval" => interval_ms = parse_duration_ms(&take_value(&mut i)?)?,
            _ if arg.starts_with('-') => return Err(format!("unsupported option: {arg}")),
            _ => {
                if id.is_some() {
                    return Err("exactly one session id is required".to_string());
                }
                id = Some(arg.clone());
            }
        }
        i += 1;
    }
    Ok(WatchArgs {
        id: id.ok_or("exactly one session id is required")?,
        timeout_ms,
        interval_ms,
    })
}

/// Sleep-style durations: `90s`, `500ms`, `5m`, `2h`, composites like `1m30s`;
/// a bare number is seconds.
pub(crate) fn parse_duration_ms(text: &str) -> Result<u64, String> {
    let invalid = || format!("invalid duration {text:?} (use forms like 30s, 500ms, 5m, 1h30m)");
    if text.is_empty() {
        return Err(invalid());
    }
    let mut rest = text;
    let mut total_ms: u64 = 0;
    while !rest.is_empty() {
        let digits = rest
            .chars()
            .take_while(|c: &char| c.is_ascii_digit())
            .count();
        if digits == 0 {
            return Err(invalid());
        }
        let (number, suffix) = rest.split_at(digits);
        let value: u64 = number.parse().map_err(|_| invalid())?;
        let unit_len = suffix
            .chars()
            .take_while(|c: &char| c.is_alphabetic())
            .count();
        let factor_ms: u64 = match suffix.get(..unit_len) {
            None | Some("") => 1_000, // bare number: seconds
            Some("ms") => 1,
            Some("s") => 1_000,
            Some("m") => 60_000,
            Some("h") => 3_600_000,
            _ => return Err(invalid()),
        };
        total_ms = value
            .checked_mul(factor_ms)
            .and_then(|ms| total_ms.checked_add(ms))
            .ok_or_else(invalid)?;
        rest = &suffix[unit_len..];
    }
    Ok(total_ms)
}

/// Current time as Unix epoch milliseconds from the durable clock (same host
/// activity session.rs uses for `date`).
fn now_ms() -> u64 {
    match workflow_support::sleep(ScheduleAt::Now, None) {
        Ok(dt) => (dt.seconds as i64 * 1000 + (dt.nanoseconds / 1_000_000) as i64).max(0) as u64,
        Err(_) => 0,
    }
}

/// Slugs label sessions and name their child join sets: lowercase letters,
/// digits, and single inner dashes.
pub(crate) fn validate_slug(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > MAX_SLUG_LEN {
        return Err(format!("slug must be 1..={MAX_SLUG_LEN} characters"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("slug allows lowercase letters, digits, and dashes".to_string());
    }
    if name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        return Err("dashes in a slug must be single and inner".to_string());
    }
    Ok(())
}

fn has_help_flag(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--help" || arg == "-h")
}

fn usage(detail: &str) -> CommandOutput {
    CommandOutput {
        stdout: String::new(),
        stderr: format!("chat: {detail}\nTry 'chat --help' for more information.\n"),
        exit_code: 2,
    }
}

fn failure(message: &str) -> CommandOutput {
    CommandOutput {
        stdout: String::new(),
        stderr: format!("chat: {message}\n"),
        exit_code: 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use just_bash_rs::{CustomCommands, Vfs};
    use std::collections::BTreeMap;

    fn interp() -> Interpreter {
        Interpreter::new(
            BTreeMap::new(),
            "/workspace".to_string(),
            Vfs::new(),
            || 0,
            CustomCommands::new(),
        )
    }

    #[test]
    fn attach_final_embeds_the_read_final_text() {
        let mut delegate: CustomCommandHandler = Box::new(|_interp, args, _stdin| {
            assert_eq!(
                args,
                &["read".to_string(), "E_x".to_string(), "--final".to_string()]
            );
            CommandOutput {
                stdout: "run just deploy\n".to_string(),
                stderr: String::new(),
                exit_code: 0,
            }
        });
        let mut payload = json!({"id": "E_x", "state": "final-response"});
        attach_final(&mut delegate, &mut interp(), "E_x", &mut payload);
        assert_eq!(payload["final"], json!("run just deploy"));
    }

    #[test]
    fn attach_final_leaves_the_field_absent_on_a_failed_read() {
        let mut delegate: CustomCommandHandler = Box::new(|_interp, _args, _stdin| CommandOutput {
            stdout: String::new(),
            stderr: "chat: unknown session\n".to_string(),
            exit_code: 1,
        });
        let mut payload = json!({"id": "E_x", "state": "unknown"});
        attach_final(&mut delegate, &mut interp(), "E_x", &mut payload);
        assert!(payload.get("final").is_none());
    }

    #[test]
    fn validate_slug_enforces_kebab_shape() {
        assert!(validate_slug("deploy-triage").is_ok());
        assert!(validate_slug("a").is_ok());
        assert!(validate_slug("a-1").is_ok());
        assert!(validate_slug("").is_err());
        assert!(validate_slug("-lead").is_err());
        assert!(validate_slug("trail-").is_err());
        assert!(validate_slug("dou--ble").is_err());
        assert!(validate_slug("Upper").is_err());
        assert!(validate_slug("under_score").is_err());
        assert!(validate_slug(&"x".repeat(MAX_SLUG_LEN + 1)).is_err());
    }

    #[test]
    fn parse_create_args_reads_flags_and_prompt_words() {
        let parsed = parse_create_args(&[
            "--model".to_string(),
            "fake".to_string(),
            "check".to_string(),
            "--effort=low".to_string(),
            "the deploy".to_string(),
        ])
        .unwrap();
        assert_eq!(parsed.prompt, "check the deploy");
        assert_eq!(parsed.model.as_deref(), Some("fake"));
        assert_eq!(parsed.effort.as_deref(), Some("low"));
        assert_eq!(parsed.name, None);

        let named = parse_create_args(&[
            "--name=research".to_string(),
            "$".to_string(),
            "ls".to_string(),
        ])
        .unwrap();
        assert_eq!(named.name.as_deref(), Some("research"));
        assert_eq!(named.prompt, "$ ls");

        let bare = parse_create_args(&[]).unwrap();
        assert_eq!(bare.prompt, "");
        assert_eq!(bare.model, None);
        assert_eq!(bare.effort, None);
        assert_eq!(bare.name, None);
    }

    #[test]
    fn parse_create_args_rejects_bad_input() {
        assert!(parse_create_args(&["--effort".to_string(), "maximum".to_string()]).is_err());
        assert!(parse_create_args(&["--wat".to_string()]).is_err());
        assert!(parse_create_args(&["--model".to_string()]).is_err());
        assert!(
            parse_create_args(&[
                "--model".to_string(),
                "a".to_string(),
                "--model=b".to_string()
            ])
            .is_err()
        );
        assert!(parse_create_args(&["--name".to_string(), "Bad_Name".to_string()]).is_err());
        assert!(
            parse_create_args(&[
                "--name".to_string(),
                "one".to_string(),
                "--name=two".to_string()
            ])
            .is_err()
        );
    }

    #[test]
    fn parent_of_derives_from_derived_execution_ids() {
        assert_eq!(
            parent_of("E_01ABC.n:research_2"),
            Some("E_01ABC".to_string())
        );
        // A grandchild's parent is the intermediate session, not the root.
        assert_eq!(
            parent_of("E_01ABC.n:a_1.n:b_1"),
            Some("E_01ABC.n:a_1".to_string())
        );
        assert_eq!(parent_of("E_01ABC"), None);
    }

    #[test]
    fn parse_watch_args_reads_flags_and_id() {
        let parsed = parse_watch_args(&[
            "--timeout=30s".to_string(),
            "E_child".to_string(),
            "--interval".to_string(),
            "500ms".to_string(),
        ])
        .unwrap();
        assert_eq!(parsed.id, "E_child");
        assert_eq!(parsed.timeout_ms, 30_000);
        assert_eq!(parsed.interval_ms, 500);

        let bare = parse_watch_args(&["E_x".to_string()]).unwrap();
        assert_eq!(bare.timeout_ms, WATCH_DEFAULT_TIMEOUT_MS);
        assert_eq!(bare.interval_ms, WATCH_DEFAULT_INTERVAL_MS);

        assert!(parse_watch_args(&[]).is_err());
        assert!(parse_watch_args(&["a".to_string(), "b".to_string()]).is_err());
        assert!(parse_watch_args(&["--wat".to_string(), "E_x".to_string()]).is_err());
        assert!(
            parse_watch_args(&["--timeout".to_string(), "E_x".to_string()]).is_err(),
            "missing option value"
        );
    }

    #[test]
    fn parse_duration_ms_accepts_sleep_style_forms() {
        assert_eq!(parse_duration_ms("30").unwrap(), 30_000);
        assert_eq!(parse_duration_ms("500ms").unwrap(), 500);
        assert_eq!(parse_duration_ms("90s").unwrap(), 90_000);
        assert_eq!(parse_duration_ms("5m").unwrap(), 300_000);
        assert_eq!(parse_duration_ms("2h").unwrap(), 7_200_000);
        assert_eq!(parse_duration_ms("1m30s").unwrap(), 90_000);
        assert!(parse_duration_ms("").is_err());
        assert!(parse_duration_ms("s").is_err());
        assert!(parse_duration_ms("10x").is_err());
        assert!(parse_duration_ms("10y").is_err());
    }

    #[test]
    fn watch_wake_states_cover_progress_stops_and_terminals() {
        for state in [
            "final-response",
            "step-limit",
            "awaiting-answer",
            "shell-only",
            "finished-ok",
            "cancelled",
            "failed",
        ] {
            assert!(WATCH_WAKE_STATES.contains(&state), "{state} should wake");
        }
        for state in ["thinking", "working", "awaiting-user", "paused", "unknown"] {
            assert!(!WATCH_WAKE_STATES.contains(&state), "{state} must not wake");
        }
    }

    #[test]
    fn stamp_watch_fields_adds_timeout_and_waited() {
        let mut payload =
            serde_json::from_str::<Value>(r#"{"id":"E_x","state":"thinking"}"#).unwrap();
        stamp_watch_fields(&mut payload, false, 1234);
        assert_eq!(payload["timed_out"], json!(false));
        assert_eq!(payload["waited_ms"], json!(1234));
        assert_eq!(payload["state"], json!("thinking"));

        let mut empty = Value::Null;
        stamp_watch_fields(&mut empty, true, 5);
        assert_eq!(empty["timed_out"], json!(true));
    }

    #[test]
    fn self_section_shows_identity_and_parent() {
        let own = ChatSelf::new(
            "E_01ABC.n:research_1".to_string(),
            "claude".to_string(),
            String::new(),
            Some("research".to_string()),
        );
        let section = self_section(&own);
        assert!(section.contains("# This session"));
        assert!(section.contains("\"execution_id\":\"E_01ABC.n:research_1\""));
        assert!(section.contains("\"name\":\"research\""));
        assert!(section.contains("chat read E_01ABC.n:research_1"));
        assert!(section.contains("chat read E_01ABC"));

        let top = ChatSelf::new("E_01XYZ".to_string(), String::new(), String::new(), None);
        let section = self_section(&top);
        // Top-level sessions carry no parent beyond the JSON null.
        assert!(section.contains("\"parent_id\":null"));
        assert!(!section.contains("child session by"));
    }
}
