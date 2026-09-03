//! PORT: vendor/just-bash/src/interpreter/{interpreter.ts, expansion.ts}
//!
//! A tree-walking evaluator for the minimal AST. It threads an environment and
//! working directory through statements, runs pipelines by piping in-memory
//! buffers between commands, and applies `&&` / `||` short-circuiting. Word
//! expansion resolves `$VAR` / `$?` / `$((expr))` against the environment,
//! IFS-splits unquoted expansions into fields, and pathname-expands purely
//! literal glob words against the virtual filesystem (see `expansion.rs` /
//! `glob.rs` for what's ported vs simplified). Commands dispatch to the
//! builtin table in `commands`.

use std::collections::BTreeMap;

use crate::arithmetic;
use crate::ast::{
    Command, CompoundCommand, LogicalOp, Pipeline, RedirectKind, RedirectTarget, Script,
    SimpleCommand, Statement, Word, WordPart,
};
use crate::brace;
use crate::commands::{self, normalize_path};
use crate::custom_command::CustomCommands;
use crate::expansion::{self, Segment};
use crate::fs::{FsError, Vfs};
use crate::glob;
use crate::types::{Fd, OutputChunk};
use crate::watch::{InterruptKind, ScriptWatch};
use std::cell::RefCell;
use std::rc::Rc;

/// Where an output descriptor points after applying a command's redirections.
/// Only the terminal streams and file targets are modelled (no external
/// processes), which covers `>`/`>>`/`2>`/`2>&1`/`1>&2`.
#[derive(Clone)]
enum OutDest {
    Stdout,
    Stderr,
    File(String),
}

/// The default destination for a bare descriptor: fd 2 is stderr, everything
/// else (fd 1 and the rare higher fds, which carry no captured content) stdout.
fn default_dest(fd: u32) -> OutDest {
    if fd == 2 {
        OutDest::Stderr
    } else {
        OutDest::Stdout
    }
}

/// The `set`-controlled shell options this port models. Persist across `exec`
/// calls via `Bash` (a `set -e` in one command stays in effect for the next).
#[derive(Debug, Clone, Copy, Default)]
pub struct ShellOptions {
    /// `set -e`: stop the script after a command fails (outside a tested
    /// context like an `if`/`while` condition or a `&&`/`||`/`!` position).
    pub errexit: bool,
    /// `set -u`: expanding an unset variable is an error that stops the script.
    pub nounset: bool,
    /// `set -x`: print each simple command to stderr before running it.
    pub xtrace: bool,
    /// `set -o pipefail`: a pipeline's status is the last non-zero command's.
    pub pipefail: bool,
}

/// Mutable state shared across a single `exec` run.
pub struct Interpreter {
    pub env: BTreeMap<String, String>,
    pub cwd: String,
    pub last_exit: i32,
    pub out: OutputLog,
    /// `set` options; seeded from `Bash` and read back after the run.
    pub options: ShellOptions,
    /// Set when `errexit`/`nounset` triggers a script-ending failure, so the
    /// statement loops stop running the rest of the script.
    pub exiting: bool,
    /// Set when the script-watch signal fired (see `Bash::set_script_watch`).
    /// Like `exiting`, statement and loop bodies short-circuit on it, but the
    /// final exit code and marker come from the interrupt kind, not
    /// `last_exit`.
    pub interrupted: Option<InterruptKind>,
    /// Host-installed abort watcher, moved in from `Bash` for this run and
    /// moved back out afterward (the same move-in/move-out pattern as `fs`).
    pub watch: Option<Rc<RefCell<dyn ScriptWatch>>>,
    /// Pending `break`/`continue` from inside a loop body. Loops consume one
    /// level each; capture contexts (`$(...)`, `sh -c`) isolate it.
    pub loop_control: Option<LoopControl>,
    /// Dynamically enclosing `for`/`while`/`until` bodies, so `break` outside
    /// any loop can be rejected like bash does.
    pub loop_depth: u32,
    /// Positional parameters: `positional[0]` is `$1`. Set when a script runs
    /// via `sh`/`bash`/`./x.sh`/`source ... args`, cleared otherwise.
    pub positional: Vec<String>,
    /// `$0`: the shell or script name.
    pub arg0: String,
    pub fs: Vfs,
    /// Reads the current time (Unix epoch milliseconds) on demand, used by
    /// `date`. See `BashOptions::now_ms`.
    pub now_ms: fn() -> i64,
    /// Durably sleeps for the given milliseconds, used by `sleep`. See
    /// `BashOptions::sleep_ms`.
    pub sleep_ms: fn(u64),
    /// Debug-log one line, called around every command dispatch. See
    /// `BashOptions::log_debug`.
    pub log_debug: fn(&str),
    /// Free-text tag prefixed onto each `log_debug` line for this script run.
    /// See `Bash::set_log_context`.
    pub log_context: Option<String>,
    /// Diagnostics only (see `try_run_simple`'s dispatch site): a monotonic
    /// count of every command dispatched this `exec()` run, and the current
    /// recursion depth (command substitution etc. re-enter dispatch while
    /// already inside one).
    invocation_seq: u64,
    invocation_depth: u32,
    /// Host-registered commands (see `custom_command.rs`), moved in from
    /// `Bash` for this run and moved back out afterward.
    pub custom_commands: CustomCommands,
    /// Counter backing each process substitution's anonymous placeholder
    /// path (`/__just_bash_procsub_N__`).
    proc_sub_counter: u32,
    /// `>(script)` substitutions expanded while building the current simple
    /// command, queued here so `try_run_simple` can run each `script` (with
    /// its placeholder file's final content as stdin) once the command that
    /// wrote to it has finished. See `run_pending_process_subs`.
    pending_output_subs: Vec<(String, Script)>,
    /// stdin queued for the very next pipeline's first stage, consumed once.
    /// The only producer today is `run_pending_process_subs` feeding a
    /// `>(script)`'s captured content to `script`.
    injected_stdin: Option<String>,
    /// Stdin supplied to the compound command currently being evaluated. A
    /// `read` in its body consumes this buffer across loop iterations.
    pub stdin_binding: Option<Rc<RefCell<String>>>,
}

/// A pending `break N` / `continue N`: how many enclosing loops to unwind.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LoopControl {
    Break(u32),
    Continue(u32),
}

/// The output of one command in a pipeline.
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// The shell's live output, recorded as an ordered list of stdout/stderr runs
/// so interleaving survives (the two flat strings alone cannot say which
/// stderr line landed between which stdout lines). Writes are already coarse:
/// each command contributes at most one stdout run and one stderr run, so no
/// extra coalescing is needed. Capture contexts (`$(...)`, pipes, compound
/// commands) `mark()` the log, run, then pull their stdout back out with
/// `take_stdout_since`, which leaves stderr in place so it still reaches the
/// terminal in order.
#[derive(Default)]
pub struct OutputLog {
    chunks: Vec<OutputChunk>,
}

impl OutputLog {
    pub fn push_out(&mut self, text: &str) {
        if !text.is_empty() {
            self.chunks.push(OutputChunk {
                fd: Fd::Stdout,
                text: text.to_string(),
            });
        }
    }

    pub fn push_err(&mut self, text: &str) {
        if !text.is_empty() {
            self.chunks.push(OutputChunk {
                fd: Fd::Stderr,
                text: text.to_string(),
            });
        }
    }

    pub fn stdout_string(&self) -> String {
        self.stream_string(Fd::Stdout)
    }

    pub fn stderr_string(&self) -> String {
        self.stream_string(Fd::Stderr)
    }

    fn stream_string(&self, fd: Fd) -> String {
        self.chunks
            .iter()
            .filter(|c| c.fd == fd)
            .map(|c| c.text.as_str())
            .collect()
    }

    pub fn mark(&self) -> usize {
        self.chunks.len()
    }

    /// Remove and concatenate the stdout produced since `mark`, leaving the
    /// stderr chunks in place (in order) so they still reach the terminal.
    pub fn take_stdout_since(&mut self, mark: usize) -> String {
        let tail = self.chunks.split_off(mark);
        let mut out = String::new();
        for chunk in tail {
            match chunk.fd {
                Fd::Stdout => out.push_str(&chunk.text),
                Fd::Stderr => self.chunks.push(chunk),
            }
        }
        out
    }

    /// Detach everything recorded since `mark` (both streams).
    pub fn split_off(&mut self, mark: usize) -> OutputLog {
        OutputLog {
            chunks: self.chunks.split_off(mark),
        }
    }

    pub fn into_chunks(self) -> Vec<OutputChunk> {
        self.chunks
    }
}

/// Default `sleep_ms`: no scheduler, so a bare interpreter never blocks (the
/// workflow installs a durable sleep, see `BashOptions::sleep_ms`).
fn no_sleep(_ms: u64) {}

/// Default `log_debug`: discards the line (the workflow installs
/// `obelisk:log/log`'s `debug`, see `BashOptions::log_debug`).
fn no_log(_msg: &str) {}

impl Interpreter {
    pub fn new(
        env: BTreeMap<String, String>,
        cwd: String,
        fs: Vfs,
        now_ms: fn() -> i64,
        custom_commands: CustomCommands,
    ) -> Self {
        Self {
            env,
            cwd,
            last_exit: 0,
            out: OutputLog::default(),
            options: ShellOptions::default(),
            exiting: false,
            interrupted: None,
            watch: None,
            loop_control: None,
            loop_depth: 0,
            positional: Vec::new(),
            arg0: "bash".to_string(),
            fs,
            now_ms,
            sleep_ms: no_sleep,
            log_debug: no_log,
            log_context: None,
            invocation_seq: 0,
            invocation_depth: 0,
            custom_commands,
            proc_sub_counter: 0,
            pending_output_subs: Vec::new(),
            injected_stdin: None,
            stdin_binding: None,
        }
    }

    /// A fresh anonymous path to back one process substitution.
    fn alloc_proc_sub_path(&mut self) -> String {
        self.proc_sub_counter += 1;
        format!("/__just_bash_procsub_{}__", self.proc_sub_counter)
    }

    /// Expand a `<(script)` / `>(script)` process substitution to the path
    /// standing in for it. This interpreter runs everything synchronously
    /// in-process (no real concurrent subprocesses or pipes), so both
    /// directions are approximated rather than genuinely concurrent:
    ///
    /// - `<(script)` runs `script` immediately and seeds the placeholder file
    ///   with its captured stdout, so whatever reads the path next (almost
    ///   always the very next command) sees it already populated.
    /// - `>(script)` seeds an empty placeholder and queues `(path, script)`;
    ///   the command using the substitution is expected to write to that path
    ///   itself (typically via `>`), and `try_run_simple` runs `script`
    ///   afterward with whatever ended up in the file as its stdin, once the
    ///   write has actually happened.
    fn expand_process_sub(&mut self, script: &Script, write: bool) -> String {
        let path = self.alloc_proc_sub_path();
        if write {
            let _ = self.fs.write_file(&path, b"");
            self.pending_output_subs
                .push((path.clone(), script.clone()));
        } else {
            let captured = self.run_captured(&script.statements);
            let _ = self.fs.write_file(&path, captured.as_bytes());
        }
        path
    }

    /// Run every `>(script)` queued by the command just executed, each fed
    /// the content its placeholder file ended up holding. Isolated the same
    /// way `run_captured` isolates a `$(...)`, but writes to the shell's real
    /// output (bash sends `>(...)`'s own output straight to the terminal, not
    /// back into the pipeline) rather than being captured.
    fn run_pending_process_subs(&mut self) {
        let pending = std::mem::take(&mut self.pending_output_subs);
        for (path, script) in pending {
            let content = self
                .fs
                .read_file(&path)
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default();
            let saved_control = self.loop_control.take();
            let saved_depth = self.loop_depth;
            self.loop_depth = 0;
            self.injected_stdin = Some(content);
            for statement in &script.statements {
                self.run_statement(statement);
            }
            self.injected_stdin = None;
            self.loop_control = saved_control;
            self.loop_depth = saved_depth;
        }
    }

    /// Resolve a word to an absolute, normalized path against the current cwd.
    /// A single-field expansion: no splitting or globbing (redirect targets
    /// name exactly one file, same as bash).
    pub fn resolve_path(&mut self, word: &Word) -> Result<String, String> {
        let expanded = self.expand_word(word)?;
        Ok(normalize_path(&self.cwd, &expanded))
    }

    /// Whether statement execution must stop: a shell-level fatality
    /// (`exiting`) or a script-watch signal (`interrupted`).
    fn halted(&self) -> bool {
        self.exiting || self.interrupted.is_some()
    }

    pub fn run(&mut self, script: &Script) {
        for statement in &script.statements {
            if self.halted() {
                break;
            }
            let eligible = self.run_statement(statement);
            self.maybe_errexit(eligible);
        }
    }

    /// Under `set -e`, stop the script when a statement failed in a position
    /// where its status is not being tested (`eligible`). Called only from
    /// list contexts (top level, compound bodies), never condition lists.
    fn maybe_errexit(&mut self, eligible: bool) {
        if eligible && self.options.errexit && self.last_exit != 0 {
            self.exiting = true;
        }
    }

    /// Parse and run `src` as a script, capturing its own stdout/stderr/exit
    /// into a `CommandOutput` (so `2>&1` and pipes compose with it). Runs
    /// against the live shell state, so a `source`d script's assignments and
    /// `cd` persist; `sh`/`bash`/`./script` callers use `run_script_isolated`.
    pub fn run_source_captured(&mut self, src: &str) -> CommandOutput {
        let script = match crate::parser::parse(src) {
            Ok(s) => s,
            Err(e) => {
                return CommandOutput {
                    stdout: String::new(),
                    stderr: format!("bash: {}\n", e.message),
                    exit_code: 2,
                };
            }
        };
        let mark = self.out.mark();
        self.run(&script);
        let produced = self.out.split_off(mark);
        CommandOutput {
            stdout: produced.stdout_string(),
            stderr: produced.stderr_string(),
            exit_code: self.last_exit,
        }
    }

    /// Like `run_source_captured` but with subshell-style isolation of `env`,
    /// `cwd`, and positional parameters (the virtual filesystem is shared, as a
    /// real subshell shares the fs). `arg0`/`args` become `$0`/`$1..` for the
    /// run. Used for `sh x.sh`, `bash x.sh`, and `./x.sh`.
    pub fn run_script_isolated(&mut self, src: &str, arg0: &str, args: &[String]) -> CommandOutput {
        let saved_env = self.env.clone();
        let saved_cwd = self.cwd.clone();
        let saved_positional = std::mem::replace(&mut self.positional, args.to_vec());
        let saved_arg0 = std::mem::replace(&mut self.arg0, arg0.to_string());
        let saved_control = self.loop_control.take();
        let saved_depth = self.loop_depth;
        self.loop_depth = 0;
        let out = self.run_source_captured(src);
        self.env = saved_env;
        self.cwd = saved_cwd;
        self.positional = saved_positional;
        self.arg0 = saved_arg0;
        self.loop_control = saved_control;
        self.loop_depth = saved_depth;
        out
    }

    /// `source file [args]`: run in the current shell (no env/cwd isolation).
    /// Positional parameters are replaced for the duration only when `args` are
    /// given (bash leaves them untouched for a bare `source file`).
    pub fn run_source_with_args(&mut self, src: &str, args: &[String]) -> CommandOutput {
        if args.is_empty() {
            return self.run_source_captured(src);
        }
        let saved_positional = std::mem::replace(&mut self.positional, args.to_vec());
        let out = self.run_source_captured(src);
        self.positional = saved_positional;
        out
    }

    /// Run one statement (a `&&`/`||` list). Returns whether its final status
    /// is `errexit`-eligible: the list ran to its end (no short-circuit left a
    /// tested command failing) and its last pipeline was not `!`-negated.
    fn run_statement(&mut self, statement: &Statement) -> bool {
        // pipelines[0] op[0] pipelines[1] op[1] ... with && / || short-circuit.
        let mut code = self.run_pipeline(&statement.pipelines[0]);
        let mut last_negated = statement.pipelines[0].negated;
        let mut reached_end = true;
        for (op, pipeline) in statement.operators.iter().zip(&statement.pipelines[1..]) {
            let run_next = match op {
                LogicalOp::And => code == 0,
                LogicalOp::Or => code != 0,
            };
            if run_next && self.loop_control.is_none() {
                code = self.run_pipeline(pipeline);
                last_negated = pipeline.negated;
            } else {
                reached_end = false;
                break;
            }
        }
        self.last_exit = code;
        reached_end && !last_negated
    }

    fn run_pipeline(&mut self, pipeline: &Pipeline) -> i32 {
        // The only source of injected stdin today is a `>(script)` process
        // substitution feeding its placeholder's content to `script`'s first
        // pipeline; ordinary pipelines just get "".
        let mut stdin = self.injected_stdin.take().unwrap_or_else(|| {
            self.stdin_binding
                .as_ref()
                .map(|binding| binding.borrow().clone())
                .unwrap_or_default()
        });
        let mut exit_code = 0;
        // `set -o pipefail`: the pipeline's status is the last non-zero
        // command's, not just the final command's.
        let mut pipefail_code = 0;
        let last = pipeline.commands.len() - 1;
        for (i, command) in pipeline.commands.iter().enumerate() {
            let out = self.run_command(command, stdin);
            self.out.push_err(&out.stderr);
            if out.exit_code != 0 {
                pipefail_code = out.exit_code;
            }
            if i == last {
                self.out.push_out(&out.stdout);
                exit_code = out.exit_code;
                stdin = String::new();
            } else {
                stdin = out.stdout;
            }
        }
        if self.options.pipefail && pipefail_code != 0 {
            exit_code = pipefail_code;
        }
        if pipeline.negated {
            exit_code = if exit_code == 0 { 1 } else { 0 };
        }
        // `last_exit` is updated by the caller after operator handling, but keep
        // it current so `$?` inside a later pipeline of the same statement sees
        // this pipeline's result.
        self.last_exit = exit_code;
        exit_code
    }

    fn run_command(&mut self, command: &Command, stdin: String) -> CommandOutput {
        match command {
            Command::Simple(cmd) => self.run_simple(cmd, stdin),
            Command::Compound(cmd) => self.run_compound(cmd, stdin),
            Command::Arith(expr) => self.run_arith_command(expr),
        }
    }

    /// `(( expr ))`: exit 0 if the result is non-zero, 1 otherwise (matching
    /// what `$((expr))` would expand to, per bash).
    fn run_arith_command(&mut self, expr: &arithmetic::ArithExpr) -> CommandOutput {
        match arithmetic::eval(expr, &mut self.env) {
            Ok(n) => CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: if n != 0 { 0 } else { 1 },
            },
            Err(msg) => CommandOutput {
                stdout: String::new(),
                stderr: format!("bash: {msg}\n"),
                exit_code: 1,
            },
        }
    }

    /// Run a compound command, capturing its stdout so it composes in a pipeline
    /// like any other command. Its stderr still flows straight to the shell's
    /// stderr.
    fn run_compound(&mut self, cmd: &CompoundCommand, stdin: String) -> CommandOutput {
        let mark = self.out.mark();
        let saved_stdin = self.stdin_binding.replace(Rc::new(RefCell::new(stdin)));
        self.exec_compound(cmd);
        self.stdin_binding = saved_stdin;
        let stdout = self.out.take_stdout_since(mark);
        CommandOutput {
            stdout,
            stderr: String::new(),
            exit_code: self.last_exit,
        }
    }

    fn exec_compound(&mut self, cmd: &CompoundCommand) {
        match cmd {
            CompoundCommand::If {
                cond,
                body,
                elifs,
                else_body,
            } => {
                if self.run_block(cond, false) == 0 {
                    self.run_block(body, true);
                    return;
                }
                for (elif_cond, elif_body) in elifs {
                    if self.loop_control.is_some() {
                        return;
                    }
                    if self.run_block(elif_cond, false) == 0 {
                        self.run_block(elif_body, true);
                        return;
                    }
                }
                if self.loop_control.is_some() {
                    return;
                }
                match else_body {
                    Some(block) => {
                        self.run_block(block, true);
                    }
                    // An `if` with no taken branch and no `else` succeeds.
                    None => self.last_exit = 0,
                }
            }
            CompoundCommand::For { name, items, body } => {
                self.last_exit = 0;
                'outer: for item in items {
                    for word in brace::expand(item) {
                        let values = match self.expand_word_to_fields(&word) {
                            Ok(values) => values,
                            Err(msg) => {
                                self.out.push_err(&format!("bash: {msg}\n"));
                                self.last_exit = 1;
                                return;
                            }
                        };
                        for value in values {
                            if self.halted() || matches!(self.poll_loop_control(), Some(true)) {
                                break 'outer;
                            }
                            self.env.insert(name.clone(), value);
                            self.loop_depth += 1;
                            self.run_block(body, true);
                            self.loop_depth -= 1;
                            if matches!(self.poll_loop_control(), Some(true)) {
                                break 'outer;
                            }
                        }
                    }
                }
            }
            CompoundCommand::CStyleFor {
                init,
                cond,
                update,
                body,
            } => {
                self.last_exit = 0;
                // Evaluate the init clause once; a failure aborts the loop.
                if let Some(init) = init
                    && let Err(msg) = arithmetic::eval(init, &mut self.env)
                {
                    self.out.push_err(&format!("bash: {msg}\n"));
                    self.last_exit = 1;
                    return;
                }
                loop {
                    if self.halted() || matches!(self.poll_loop_control(), Some(true)) {
                        break;
                    }
                    // An absent condition is always true (`for ((;;))`).
                    if let Some(cond) = cond {
                        match arithmetic::eval(cond, &mut self.env) {
                            Ok(0) => break,
                            Ok(_) => {}
                            Err(msg) => {
                                self.out.push_err(&format!("bash: {msg}\n"));
                                self.last_exit = 1;
                                return;
                            }
                        }
                    }
                    self.loop_depth += 1;
                    self.run_block(body, true);
                    self.loop_depth -= 1;
                    if matches!(self.poll_loop_control(), Some(true)) {
                        break;
                    }
                    // A depth-1 `continue` falls through so the update clause
                    // still runs (matching bash).
                    if let Some(update) = update
                        && let Err(msg) = arithmetic::eval(update, &mut self.env)
                    {
                        self.out.push_err(&format!("bash: {msg}\n"));
                        self.last_exit = 1;
                        return;
                    }
                }
            }
            CompoundCommand::While { cond, body, until } => {
                self.last_exit = 0;
                let mut loop_exit = 0;
                loop {
                    if self.halted() || matches!(self.poll_loop_control(), Some(true)) {
                        break;
                    }
                    // The condition list counts as inside the loop too, so a
                    // `break` there targets this loop (matching bash).
                    self.loop_depth += 1;
                    let cond_code = self.run_block(cond, false);
                    let enter = if *until {
                        cond_code != 0
                    } else {
                        cond_code == 0
                    };
                    if enter && self.loop_control.is_none() {
                        loop_exit = self.run_block(body, true);
                    }
                    self.loop_depth -= 1;
                    if !enter || matches!(self.poll_loop_control(), Some(true)) {
                        break;
                    }
                }
                self.last_exit = loop_exit;
            }
            CompoundCommand::Case { subject, arms } => {
                self.last_exit = 0;
                let value = match self.expand_word(subject) {
                    Ok(value) => value,
                    Err(msg) => {
                        self.out.push_err(&format!("bash: {msg}\n"));
                        self.last_exit = 1;
                        return;
                    }
                };
                'arms: for arm in arms {
                    for pattern in &arm.patterns {
                        let pat = match self.expand_word(pattern) {
                            Ok(pat) => pat,
                            Err(msg) => {
                                self.out.push_err(&format!("bash: {msg}\n"));
                                self.last_exit = 1;
                                return;
                            }
                        };
                        // Both words are single fields here (no IFS split), so
                        // the pattern matches the subject whole.
                        if glob::match_segment(&pat, &value) {
                            self.run_block(&arm.body, true);
                            break 'arms;
                        }
                    }
                }
            }
            // `{ list; }`: runs right here, so env/cwd/positional mutations
            // and a `break`/`continue` all reach the enclosing shell/loop
            // exactly like they would if `list` had been inlined directly.
            CompoundCommand::Group(body) => {
                self.run_block(body, true);
            }
            // `( list )`: bash forks a child shell for this, so none of
            // `list`'s mutations (env, cwd, positional params, shell
            // options) or a stray `break`/`continue` are visible once it
            // returns -- only its exit status and captured output are (the
            // latter already handled by `run_compound`'s mark/take-stdout
            // wrapper around this whole function).
            CompoundCommand::Subshell(body) => {
                let saved_env = self.env.clone();
                let saved_cwd = self.cwd.clone();
                let saved_positional = self.positional.clone();
                let saved_options = self.options;
                let saved_control = self.loop_control.take();
                let saved_depth = self.loop_depth;
                self.loop_depth = 0;
                self.run_block(body, true);
                self.env = saved_env;
                self.cwd = saved_cwd;
                self.positional = saved_positional;
                self.options = saved_options;
                self.loop_control = saved_control;
                self.loop_depth = saved_depth;
            }
        }
    }

    /// Run a statement list. `errexit_ctx` is true for command bodies (where
    /// `set -e` applies) and false for `if`/`while` condition lists (where a
    /// failing command is being tested, so `-e` is suppressed).
    fn run_block(&mut self, statements: &[Statement], errexit_ctx: bool) -> i32 {
        for statement in statements {
            if self.halted() || self.loop_control.is_some() {
                break;
            }
            let eligible = self.run_statement(statement);
            if errexit_ctx {
                self.maybe_errexit(eligible);
            }
        }
        self.last_exit
    }

    /// Consume one level of a pending `break`/`continue` after a loop body or
    /// condition ran. `None`: nothing pending. `Some(true)`: this loop stops
    /// (a break landed here, or a deeper control unwound past this level).
    /// `Some(false)`: a depth-1 `continue` was consumed; the next iteration
    /// proceeds.
    fn poll_loop_control(&mut self) -> Option<bool> {
        let control = self.loop_control?;
        match control {
            LoopControl::Break(1) | LoopControl::Continue(1) => {
                self.loop_control = None;
                Some(matches!(control, LoopControl::Break(1)))
            }
            LoopControl::Break(depth) => {
                self.loop_control = Some(LoopControl::Break(depth - 1));
                Some(true)
            }
            LoopControl::Continue(depth) => {
                self.loop_control = Some(LoopControl::Continue(depth - 1));
                Some(true)
            }
        }
    }

    /// Run a simple command, turning a word-expansion failure (e.g. `$((1/0))`
    /// in an argument) into the same `bash: {msg}` / exit 1 shape bash uses
    /// instead of running the command at all.
    fn run_simple(&mut self, cmd: &SimpleCommand, stdin: String) -> CommandOutput {
        let result = match self.try_run_simple(cmd, stdin) {
            Ok(result) => result,
            Err(msg) => CommandOutput {
                stdout: String::new(),
                stderr: format!("bash: {msg}\n"),
                exit_code: 1,
            },
        };
        // Any `>(script)` substitutions this command's words expanded to have
        // now had their chance to be written to; run each queued `script`.
        if !self.pending_output_subs.is_empty() {
            self.run_pending_process_subs();
        }
        result
    }

    fn try_run_simple(
        &mut self,
        cmd: &SimpleCommand,
        stdin: String,
    ) -> Result<CommandOutput, String> {
        // Resolve redirections up front, LEFT TO RIGHT and transactionally:
        // bash applies each redirection as it's encountered, so a later
        // redirection that fails (e.g. a missing `<` target) leaves every
        // earlier one's side effects (a `>` target already truncated) in
        // place rather than rolling them back. The output plan (`dests`)
        // maps each descriptor to where it points, seeded with the terminal
        // streams and mutated in source order so `2>&1 >f` differs from
        // `>f 2>&1`. `>`/`>>` targets are truncated/created here, immediately,
        // rather than deferred to `route_output`, so that ordering holds.
        let mut stdin = stdin;
        let mut dests: BTreeMap<u32, OutDest> =
            BTreeMap::from([(1, OutDest::Stdout), (2, OutDest::Stderr)]);
        for redirect in &cmd.redirects {
            match &redirect.target {
                RedirectTarget::File(word) => {
                    let path = self.resolve_path(word)?;
                    self.fs.ensure_mounted_for(&path);
                    match redirect.kind {
                        RedirectKind::Read => match self.fs.read_file(&path).as_deref() {
                            Some(bytes) => stdin = String::from_utf8_lossy(bytes).into_owned(),
                            None => {
                                return Ok(CommandOutput {
                                    stdout: String::new(),
                                    stderr: format!("bash: {path}: No such file or directory\n"),
                                    exit_code: 1,
                                });
                            }
                        },
                        RedirectKind::Write | RedirectKind::Append => {
                            let append = matches!(redirect.kind, RedirectKind::Append);
                            let write = if append {
                                self.fs.append_file(&path, b"")
                            } else {
                                self.fs.write_file(&path, b"")
                            };
                            match write {
                                Err(FsError::IsDirectory(p)) => {
                                    return Ok(CommandOutput {
                                        stdout: String::new(),
                                        stderr: format!("bash: {p}: Is a directory\n"),
                                        exit_code: 1,
                                    });
                                }
                                Err(FsError::ReadUnavailable(p)) => {
                                    return Ok(CommandOutput {
                                        stdout: String::new(),
                                        stderr: format!("bash: {p}: File body is unavailable\n"),
                                        exit_code: 1,
                                    });
                                }
                                _ => {}
                            }
                            dests.insert(redirect.fd, OutDest::File(path));
                        }
                    }
                }
                // `n>&m`: fd n now points wherever fd m currently does. `<&m`
                // input duplication has no per-fd input model, so it's ignored.
                RedirectTarget::Dup(target_fd) => {
                    if matches!(redirect.kind, RedirectKind::Read) {
                        continue;
                    }
                    let dest = dests
                        .get(target_fd)
                        .cloned()
                        .unwrap_or_else(|| default_dest(*target_fd));
                    dests.insert(redirect.fd, dest);
                }
                RedirectTarget::HereDoc(body) => {
                    stdin = self.expand_word(body)?;
                }
            }
        }

        // Assignment-only command: persist to the environment. Any redirections
        // still create/truncate their target files.
        if cmd.words.is_empty() {
            for assignment in &cmd.assignments {
                let value = self.expand_word(&assignment.value)?;
                self.env.insert(assignment.name.clone(), value);
            }
            let mut result = CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
            };
            self.route_output(&mut result, &dests);
            return Ok(result);
        }

        let mut args: Vec<String> = Vec::new();
        for word in &cmd.words {
            for braced in brace::expand(word) {
                args.extend(self.expand_word_to_fields(&braced)?);
            }
        }
        if args.is_empty() {
            // Every word expanded away (e.g. a bare unset `$var`): bash runs
            // this as a no-op, not "command not found".
            let mut result = CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
            };
            self.route_output(&mut result, &dests);
            return Ok(result);
        }
        // Prefix assignments (`X=1 cmd`) apply only to `cmd`'s environment.
        // With no external processes yet, they are visible to builtins via a
        // scoped overlay.
        let mut scoped: Option<BTreeMap<String, String>> = None;
        if !cmd.assignments.is_empty() {
            let mut overlay = self.env.clone();
            for assignment in &cmd.assignments {
                let value = self.expand_word(&assignment.value)?;
                overlay.insert(assignment.name.clone(), value);
            }
            scoped = Some(overlay);
        }

        // `set -x`: trace the command to the shell's stderr (unaffected by the
        // command's own redirections, matching bash) before running it.
        if self.options.xtrace {
            self.out.push_err(&format!("+ {}\n", args.join(" ")));
        }

        // Fire a deferred mount (the deployment tree) if this command references
        // a path under its root, so a session that never touches the deployment
        // never fetches it. Check the cwd (for `cd .../current; cat foo`) and
        // each expanded argument (for absolute or `./`-relative references).
        // Runs after glob expansion, so a glob as the *first* reference in a
        // session lists nothing until the mount materializes on the next access;
        // the common ls/cat/cd/test paths trigger it directly.
        let cwd = self.cwd.clone();
        self.fs.ensure_mounted_for(&cwd);
        for arg in &args {
            self.fs
                .ensure_mounted_for(&commands::normalize_path(&cwd, arg));
        }

        let is_custom = self.custom_commands.contains(&args[0]);
        let kind = if is_custom { "custom" } else { "builtin" };
        let ctx = self
            .log_context
            .as_deref()
            .map(|c| format!("{c} "))
            .unwrap_or_default();
        self.invocation_seq += 1;
        self.invocation_depth += 1;
        let seq = self.invocation_seq;
        let depth = self.invocation_depth;
        (self.log_debug)(&format!(
            "{ctx}bash step start: seq={seq} depth={depth} [{kind}] {args:?}"
        ));
        let mut result = commands::dispatch(self, &args, stdin, scoped);
        (self.log_debug)(&format!(
            "{ctx}bash step done: seq={seq} depth={depth} [{kind}] {} exit_code={}",
            args[0], result.exit_code
        ));
        self.invocation_depth -= 1;
        self.route_output(&mut result, &dests);
        Ok(result)
    }

    /// Route a finished command's stdout (fd 1) and stderr (fd 2) through the
    /// redirection plan built in `try_run_simple`. File targets were already
    /// truncated/created transactionally as their redirections were parsed
    /// (see the comment there); this only appends the command's captured
    /// output to wherever each descriptor ended up pointing.
    fn route_output(&mut self, result: &mut CommandOutput, dests: &BTreeMap<u32, OutDest>) {
        let raw_out = std::mem::take(&mut result.stdout);
        let raw_err = std::mem::take(&mut result.stderr);
        let mut new_out = String::new();
        let mut new_err = String::new();

        for (fd, content) in [(1u32, raw_out), (2u32, raw_err)] {
            match dests.get(&fd).cloned().unwrap_or_else(|| default_dest(fd)) {
                OutDest::Stdout => new_out.push_str(&content),
                OutDest::Stderr => new_err.push_str(&content),
                OutDest::File(path) => {
                    let _ = self.fs.append_file(&path, content.as_bytes());
                }
            }
        }
        result.stdout = new_out;
        result.stderr = new_err;
    }

    /// Expand one word into a single field: no IFS splitting, no globbing.
    /// Used where bash itself never splits/globs: assignment values and
    /// redirect targets.
    pub fn expand_word(&mut self, word: &Word) -> Result<String, String> {
        let mut out = String::new();
        for part in word {
            match part {
                WordPart::Literal(s) | WordPart::QuotedLiteral(s) => out.push_str(s),
                WordPart::Variable { name, .. } => out.push_str(&self.lookup_field(name)?),
                WordPart::CommandSub { script, .. } => {
                    let captured = self.run_captured(&script.statements);
                    out.push_str(captured.trim_end_matches('\n'));
                }
                WordPart::Arith { expr, .. } => {
                    let n = arithmetic::eval(expr, &mut self.env)?;
                    out.push_str(&n.to_string());
                }
                WordPart::ProcessSub { script, write } => {
                    out.push_str(&self.expand_process_sub(script, *write));
                }
            }
        }
        Ok(out)
    }

    /// Expand one word into zero or more fields: IFS-splits unquoted
    /// expansions, then pathname-expands the word against the virtual
    /// filesystem if it is made entirely of unquoted literal text containing
    /// a glob metacharacter (see `glob.rs` for why globbing is restricted to
    /// that case). Used for command arguments and `for ... in` items, the two
    /// bash contexts that do split and glob.
    pub fn expand_word_to_fields(&mut self, word: &Word) -> Result<Vec<String>, String> {
        // A bare `$@`/`$*` is the one expansion that can produce more than one
        // field from a single part (`"$@"` -> one field per parameter), so it
        // is resolved before the general per-part segment loop below. Mixed
        // words like `"pre$@"` fall through and use the space-joined string.
        if let [WordPart::Variable { name, quoted }] = word.as_slice()
            && (name == "@" || name == "*")
        {
            return Ok(self.expand_positional(name == "*", *quoted));
        }
        let mut segments = Vec::with_capacity(word.len());
        for part in word {
            let segment = match part {
                WordPart::Literal(s) => Segment::merge(s.clone()),
                WordPart::QuotedLiteral(s) => Segment::anchor(s.clone()),
                WordPart::Variable { name, quoted } => {
                    let value = self.lookup_field(name)?;
                    if *quoted {
                        Segment::anchor(value)
                    } else {
                        Segment::splittable(value)
                    }
                }
                WordPart::CommandSub { script, quoted } => {
                    let captured = self.run_captured(&script.statements);
                    let value = captured.trim_end_matches('\n').to_string();
                    if *quoted {
                        Segment::anchor(value)
                    } else {
                        Segment::splittable(value)
                    }
                }
                WordPart::Arith { expr, quoted } => {
                    let n = arithmetic::eval(expr, &mut self.env)?;
                    let value = n.to_string();
                    if *quoted {
                        Segment::anchor(value)
                    } else {
                        Segment::splittable(value)
                    }
                }
                // Never split/globbed: it's always our own synthetic path,
                // never containing whitespace or glob metacharacters.
                WordPart::ProcessSub { script, write } => {
                    Segment::anchor(self.expand_process_sub(script, *write))
                }
            };
            segments.push(segment);
        }

        let ifs = self
            .env
            .get("IFS")
            .cloned()
            .unwrap_or_else(|| expansion::DEFAULT_IFS.to_string());
        let fields = expansion::expand_fields(&segments, &ifs);

        // Globbing only applies to a word made entirely of unquoted literal
        // text (see glob.rs docs); such a word always yields exactly one
        // field above, so there's exactly one candidate pattern to expand.
        if word_is_glob_candidate(word)
            && let Some(pattern) = fields.first()
        {
            let matches = glob::expand(pattern, &self.cwd, &self.fs);
            if !matches.is_empty() {
                return Ok(matches);
            }
        }
        Ok(fields)
    }

    /// Run a nested statement list and return its captured stdout, leaving the
    /// shell's own stdout untouched. Used by command substitution.
    fn run_captured(&mut self, statements: &[Statement]) -> String {
        // A `$(...)` is its own shell: a `break`/`continue` inside must not
        // reach the caller's loops.
        let saved_control = self.loop_control.take();
        let saved_depth = self.loop_depth;
        self.loop_depth = 0;
        let mark = self.out.mark();
        for statement in statements {
            self.run_statement(statement);
        }
        let captured = self.out.take_stdout_since(mark);
        self.loop_control = saved_control;
        self.loop_depth = saved_depth;
        captured
    }

    fn lookup(&self, name: &str) -> String {
        match name {
            "?" => self.last_exit.to_string(),
            "#" => self.positional.len().to_string(),
            // Single-string contexts (assignment values, arithmetic, `$*`/`$@`
            // inside other text): both join the params with a space. The
            // separate-word behaviour of `"$@"` lives in `expand_positional`.
            "@" | "*" => self.positional.join(" "),
            "0" => self.arg0.clone(),
            // The parser yields an empty variable name for a `$` that starts
            // no expansion; bash keeps such a `$` literal (so a command like
            // `chat create $ ls` passes the `$` through as an argument).
            "" => "$".to_string(),
            _ => {
                if let Some(idx) = positional_index(name) {
                    return self.positional.get(idx - 1).cloned().unwrap_or_default();
                }
                self.env.get(name).cloned().unwrap_or_default()
            }
        }
    }

    /// Expand a bare `$@`/`$*` word into fields. Quoted `"$@"` yields one field
    /// per parameter (the usual argument-forwarding form); quoted `"$*"` joins
    /// them with the first IFS character; unquoted forms join with a space and
    /// then IFS-split, like any other unquoted expansion.
    fn expand_positional(&self, star: bool, quoted: bool) -> Vec<String> {
        if quoted {
            if star {
                let sep = self.ifs_first_char();
                vec![self.positional.join(&sep)]
            } else {
                self.positional.clone()
            }
        } else {
            let ifs = self
                .env
                .get("IFS")
                .cloned()
                .unwrap_or_else(|| expansion::DEFAULT_IFS.to_string());
            expansion::expand_fields(&[Segment::splittable(self.positional.join(" "))], &ifs)
        }
    }

    /// The field separator `"$*"` joins with: the first character of IFS, or a
    /// space when IFS is unset (bash's default). An empty IFS joins with nothing.
    fn ifs_first_char(&self) -> String {
        match self.env.get("IFS") {
            None => " ".to_string(),
            Some(ifs) => ifs.chars().next().map(String::from).unwrap_or_default(),
        }
    }

    /// `set -u`-aware variable read: an unset plain variable ends the script
    /// with an "unbound variable" error; everything else defers to `lookup`.
    fn lookup_field(&mut self, name: &str) -> Result<String, String> {
        if self.options.nounset && is_plain_var(name) && !self.env.contains_key(name) {
            self.exiting = true;
            return Err(format!("{name}: unbound variable"));
        }
        Ok(self.lookup(name))
    }
}

/// A positional-parameter name (`1`, `2`, ..., but not `0`, which is `$0`):
/// all-digits and at least 1. Returns the 1-based index it refers to.
fn positional_index(name: &str) -> Option<usize> {
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    name.parse::<usize>().ok().filter(|n| *n >= 1)
}

/// A plain variable identifier (`FOO`, `_x1`): the only names `set -u` guards.
/// Special params (`$?`, the bare `$`) and unsupported forms (`${x:-y}`) are
/// excluded so nounset never fires spuriously on them.
fn is_plain_var(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// True if `word` is made entirely of unquoted literal text containing a
/// glob metacharacter, the only shape this port pathname-expands (see
/// `glob.rs`'s module docs for why mixing quotes/expansions with glob chars
/// in the same word is deliberately out of scope).
fn word_is_glob_candidate(word: &Word) -> bool {
    word.iter().all(|p| matches!(p, WordPart::Literal(_)))
        && word
            .iter()
            .any(|p| matches!(p, WordPart::Literal(s) if glob::has_meta(s)))
}
