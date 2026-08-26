//! Caller-aware subcommands of the `chat` shell program. The activity behind
//! `chat` speaks HTTP to this Obelisk instance but cannot know which session
//! invoked it, nor schedule child executions; the session loop wraps that
//! program's generic handler and intercepts what only a session can answer:
//! `current` (identity), `rename` (slug), and `create` (child scheduling by
//! default). Everything else delegates to the activity unchanged.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use just_bash_rs::CustomCommandHandler;
use just_bash_rs::interpreter::CommandOutput;

use crate::generated::obelisk::workflow::workflow_support::{self, JoinSet};
use crate::generated::obelisk_agent::workflow_obelisk_ext::workflow as workflow_ext;
use crate::session::Notifications;

pub(crate) const CHAT_PROGRAM_FFQN: &str = "obelisk-agent:programs/program.chat";

const DEFAULT_PEERS_JOIN_SET: &str = "peers";
const MAX_SLUG_LEN: usize = 64;
const EFFORTS: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

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
            create_child(&own, rest)
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
with `chat read {}`. When your task settles into something nameable, rename \
this session once to a short kebab slug summarizing that task \
(`chat rename <slug>`); do not rename repeatedly or preemptively.\n",
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

fn create_child(own: &ChatSelf, args: &[String]) -> CommandOutput {
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
    CommandOutput {
        stdout: format!("{}\n", execution_id.id),
        stderr: String::new(),
        exit_code: 0,
    }
}

struct CreateArgs {
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    name: Option<String>,
}

// Mirrors the activity-side create parser for the flags that matter to child
// scheduling; --top-level never reaches here.
fn parse_create_args(args: &[String]) -> Result<CreateArgs, String> {
    let mut positional = Vec::new();
    let mut model = None;
    let mut effort = None;
    let mut name = None;
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
    })
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
