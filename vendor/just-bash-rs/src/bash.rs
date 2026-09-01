//! PORT: vendor/just-bash/src/EmbeddedBash.ts and src/Bash.ts
//!
//! `Bash` is the single public entrypoint the workflow session loop drives. One
//! instance holds the environment and working directory for the whole durable
//! session; `exec` runs one script and returns its output plus the post-run
//! environment (the loop reads `PWD` to persist the working dir). The virtual
//! filesystem is added in the interpreter/VFS phase.

use std::collections::BTreeMap;

use crate::custom_command::{CustomCommandHandler, CustomCommands};
use crate::fs::Vfs;
use crate::interpreter::{Interpreter, ShellOptions};
use crate::parser::parse;
use crate::types::{BashOptions, ExecOptions, ExecResult, Fd, OutputChunk};
use crate::watch::{InterruptKind, SharedScriptWatch};
use std::cell::RefCell;
use std::rc::Rc;

/// A virtual bash environment with persistent session state.
pub struct Bash {
    options: BashOptions,
    cwd: String,
    env: BTreeMap<String, String>,
    fs: Vfs,
    /// `set`-controlled options, persisted across `exec` calls so a session's
    /// `set -e`/`set -o pipefail` stays in effect for later commands.
    shell_options: ShellOptions,
    /// Positional parameters (`$1..`), persisted across `exec` so a session's
    /// `set -- a b` stays visible to later commands. `$0` stays the shell name
    /// at the top level, so it is not threaded here.
    positional: Vec<String>,
    /// Host-registered commands, e.g. the obelisk-control pack's `obelisk`
    /// command (`obelisk_pack.rs`). Not part of `BashOptions` since a boxed
    /// `FnMut` closure can't derive `Clone`/`Debug` like the rest of that
    /// struct; register via `register_command` after construction instead.
    custom_commands: CustomCommands,
    /// Per-script abort watcher (see `watch.rs`); same reasoning as
    /// `custom_commands` for why it lives outside `BashOptions`.
    watch: Option<Rc<RefCell<dyn crate::watch::ScriptWatch>>>,
}

impl Bash {
    pub fn new(options: BashOptions) -> Self {
        let cwd = options.cwd.clone();
        let mut env = BTreeMap::new();
        env.insert("PWD".to_string(), cwd.clone());
        let mut fs = Vfs::new();
        // The working directory always exists so `ls`/`cd` see it.
        let _ = fs.mkdir(&cwd, true);
        Self {
            options,
            cwd,
            env,
            fs,
            shell_options: ShellOptions::default(),
            positional: Vec::new(),
            custom_commands: CustomCommands::new(),
            watch: None,
        }
    }

    /// Install the abort watcher observed at durable boundaries (after custom
    /// commands and inside `sleep`). The session loop swaps it in before one
    /// script and takes it back out afterward.
    pub fn set_script_watch(&mut self, watch: Option<SharedScriptWatch>) {
        self.watch = watch;
    }

    /// Register a command backed by a host closure, checked after the builtin
    /// table when a command name doesn't match one of those (see
    /// `commands::dispatch`).
    pub fn register_command(&mut self, name: impl Into<String>, handler: CustomCommandHandler) {
        self.custom_commands.register(name, handler);
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    pub fn options(&self) -> &BashOptions {
        &self.options
    }

    /// The session's virtual filesystem. The workflow mounts the pack into this
    /// and reads results back out.
    pub fn fs(&self) -> &Vfs {
        &self.fs
    }

    pub fn fs_mut(&mut self) -> &mut Vfs {
        &mut self.fs
    }

    /// Run one script. Returns stdout/stderr/exit-code and the post-run
    /// environment. Environment and working directory persist to the next call.
    pub fn exec(&mut self, script: &str, opts: ExecOptions) -> ExecResult {
        let start_cwd = opts.cwd.clone().unwrap_or_else(|| self.cwd.clone());

        let ast = match parse(script) {
            Ok(ast) => ast,
            Err(error) => {
                let stderr = format!("{error}\n");
                return ExecResult {
                    output: vec![OutputChunk {
                        fd: Fd::Stderr,
                        text: stderr.clone(),
                    }],
                    stdout: String::new(),
                    stderr,
                    exit_code: 2,
                    env: self.env.clone(),
                    interrupted: None,
                };
            }
        };

        let fs = std::mem::take(&mut self.fs);
        let custom_commands = std::mem::take(&mut self.custom_commands);
        let mut interp = Interpreter::new(
            self.env.clone(),
            start_cwd,
            fs,
            self.options.now_ms,
            custom_commands,
        );
        interp.sleep_ms = self.options.sleep_ms;
        interp.options = self.shell_options;
        interp.positional = std::mem::take(&mut self.positional);
        interp.watch = self.watch.take();
        interp.run(&ast);
        self.watch = interp.watch.take();

        // Persist session state for the next exec.
        self.env = interp.env.clone();
        self.cwd = interp.cwd.clone();
        self.fs = interp.fs;
        self.shell_options = interp.options;
        self.positional = std::mem::take(&mut interp.positional);
        self.custom_commands = interp.custom_commands;

        // An interrupt overrides whatever status the last statement left:
        // 124 (timeout) / 130 (operator) is what callers check.
        let exit_code = match interp.interrupted {
            Some(kind) => kind.exit_code(),
            None => interp.last_exit,
        };
        let interrupted: Option<InterruptKind> = interp.interrupted;
        let env = interp.env;
        let stdout = interp.out.stdout_string();
        let stderr = interp.out.stderr_string();
        ExecResult {
            stdout,
            stderr,
            output: interp.out.into_chunks(),
            exit_code,
            env,
            interrupted,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(bash: &mut Bash, script: &str) -> ExecResult {
        bash.exec(script, ExecOptions::default())
    }

    fn fresh() -> Bash {
        Bash::new(BashOptions {
            cwd: "/workspace".into(),
            ..Default::default()
        })
    }

    fn chunks(out: &ExecResult) -> Vec<(Fd, &str)> {
        out.output.iter().map(|c| (c.fd, c.text.as_str())).collect()
    }

    #[test]
    fn output_preserves_stdout_stderr_interleaving() {
        let mut bash = fresh();
        let out = run(&mut bash, "echo out1; echo err1 >&2; echo out2");
        assert_eq!(
            chunks(&out),
            vec![
                (Fd::Stdout, "out1\n"),
                (Fd::Stderr, "err1\n"),
                (Fd::Stdout, "out2\n"),
            ]
        );
        // The flat views still work and are just the per-stream projection.
        assert_eq!(out.stdout, "out1\nout2\n");
        assert_eq!(out.stderr, "err1\n");
    }

    #[test]
    fn output_excludes_captured_stdout_but_keeps_its_stderr() {
        let mut bash = fresh();
        // The `$(...)` stdout is consumed into `x`, so only its stderr and the
        // final `echo` reach the transcript, in order.
        let out = run(&mut bash, "x=$(echo e >&2; echo v); echo $x");
        assert_eq!(chunks(&out), vec![(Fd::Stderr, "e\n"), (Fd::Stdout, "v\n")]);
    }

    #[test]
    fn output_pipe_only_records_final_stdout() {
        let mut bash = fresh();
        let out = run(&mut bash, "echo hello | cat");
        assert_eq!(chunks(&out), vec![(Fd::Stdout, "hello\n")]);
    }

    #[test]
    fn echo_hello() {
        let mut bash = fresh();
        let out = run(&mut bash, "echo hello world");
        assert_eq!(out.stdout, "hello world\n");
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn pipeline_pipes_stdin() {
        let mut bash = fresh();
        let out = run(&mut bash, "echo hi | cat");
        assert_eq!(out.stdout, "hi\n");
    }

    #[test]
    fn jq_tsv_pipeline_sorts_by_tab_delimited_field() {
        let mut bash = fresh();
        let input = r#"[{"execution_id":"E_2","ffqn":"b","created_at":"2026-08-09T09:00:00Z","pending_state":{"status":"running"}},{"execution_id":"E_1","ffqn":"a","created_at":"2026-08-09T10:00:00Z","pending_state":{"status":"finished","result_kind":{"err":{"execution_failure":"timed_out"}}}}]"#;
        bash.fs_mut()
            .write_file("/executions.json", input.as_bytes())
            .unwrap();
        let out = run(
            &mut bash,
            r#"cat /executions.json | jq -r '.[] | select(.created_at >= "2026-08-09T08:29:00Z") | [.execution_id, .ffqn, .pending_state.status, (.pending_state.result_kind // "pending" | if type == "object" then keys[0] else . end)] | @tsv' | sort -t$'\t' -k3,3"#,
        );
        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        assert_eq!(
            out.stdout,
            "E_1\ta\tfinished\terr\nE_2\tb\trunning\tpending\n"
        );
    }

    #[test]
    fn for_loop_over_numeric_brace_range() {
        let mut bash = fresh();
        let out = run(&mut bash, "for i in {0..4}; do echo $i; done");
        assert_eq!(out.stdout, "0\n1\n2\n3\n4\n");
    }

    #[test]
    fn echo_expands_comma_brace_list() {
        let mut bash = fresh();
        let out = run(&mut bash, "echo pre{a,b,c}post");
        assert_eq!(out.stdout, "preapost prebpost precpost\n");
    }

    #[test]
    fn variables_persist_across_exec() {
        let mut bash = fresh();
        run(&mut bash, "X=42");
        let out = run(&mut bash, "echo $X");
        assert_eq!(out.stdout, "42\n");
    }

    #[test]
    fn logical_and_or_short_circuit() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "true && echo yes").stdout, "yes\n");
        assert_eq!(run(&mut bash, "false && echo no").stdout, "");
        assert_eq!(
            run(&mut bash, "false || echo recovered").stdout,
            "recovered\n"
        );
    }

    #[test]
    fn cd_updates_pwd_and_persists() {
        let mut bash = fresh();
        run(&mut bash, "mkdir /tmp");
        run(&mut bash, "cd /tmp");
        let out = run(&mut bash, "pwd");
        assert_eq!(out.stdout, "/tmp\n");
        assert_eq!(out.env.get("PWD").map(String::as_str), Some("/tmp"));
    }

    #[test]
    fn cd_into_a_missing_directory_fails_and_keeps_cwd() {
        let mut bash = fresh();
        let out = run(&mut bash, "cd nope");
        assert_eq!(out.exit_code, 1);
        assert_eq!(out.stderr, "bash: cd: nope: No such file or directory\n");
        // The cwd is unchanged after the failed cd.
        assert_eq!(run(&mut bash, "pwd").stdout, "/workspace\n");
        // A file target reports "Not a directory"; and `missing/..`, which
        // normalizes back to an existing dir, still fails on the bad component.
        run(&mut bash, "touch f");
        assert_eq!(
            run(&mut bash, "cd f").stderr,
            "bash: cd: f: Not a directory\n"
        );
        assert_eq!(
            run(&mut bash, "cd missing/..").stderr,
            "bash: cd: missing/..: No such file or directory\n"
        );
    }

    #[test]
    fn exit_status_variable() {
        let mut bash = fresh();
        let out = run(&mut bash, "false; echo $?");
        assert_eq!(out.stdout, "1\n");
    }

    #[test]
    fn unknown_command_reports_error() {
        let mut bash = fresh();
        let out = run(&mut bash, "nope");
        assert_eq!(out.exit_code, 127);
        assert!(out.stderr.contains("command not found"));
    }

    #[test]
    fn case_selects_the_first_matching_arm_only() {
        let mut bash = fresh();
        let out = run(
            &mut bash,
            "case b in a) echo A;; b) echo B;; *) echo OTHER;; esac",
        );
        assert_eq!(out.stdout, "B\n");
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn case_without_a_matching_arm_succeeds_silently() {
        let mut bash = fresh();
        let out = run(&mut bash, "case z in a) echo A;; esac; echo after-$?");
        assert_eq!(out.stdout, "after-0\n");
    }

    #[test]
    fn case_glob_quoted_and_paren_patterns() {
        let mut bash = fresh();
        // Glob match with alternation, the shape models write for state guards.
        let out = run(
            &mut bash,
            "ST=cancelled\ncase \"$ST\" in *fail*|*cancel*|*finished*) echo DONE;; *) echo OTHER;; esac",
        );
        assert_eq!(out.stdout, "DONE\n");
        // A quoted `)` is pattern text; the terminator rides on the next
        // unquoted paren.
        let out = run(&mut bash, "case 'a)b' in \"a)b\") echo Q;; esac");
        assert_eq!(out.stdout, "Q\n");
        // Optional leading paren around the pattern list.
        let out = run(&mut bash, "case foo in ( foo|bar ) echo P;; esac");
        assert_eq!(out.stdout, "P\n");
    }

    #[test]
    fn case_break_exits_the_enclosing_loop_early() {
        let mut bash = fresh();
        // Regression from E_01M0YMJ0ZDEKJ4QSMDMJWEHFNN: this guard used to run
        // every iteration as unknown commands (`case`, `break`, `esac`).
        let out = run(
            &mut bash,
            "for i in 1 2 3 4 5; do\ncase \"$i\" in 2) echo two; break;; esac\necho seen-$i\ndone",
        );
        assert_eq!(out.stdout, "seen-1\ntwo\n");
        assert_eq!(out.stderr, "");
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn continue_skips_to_the_next_iteration() {
        let mut bash = fresh();
        let out = run(
            &mut bash,
            "for i in 1 2 3; do if [ $i = 2 ]; then continue; fi; echo go-$i; done",
        );
        assert_eq!(out.stdout, "go-1\ngo-3\n");
    }

    #[test]
    fn cstyle_for_continue_still_runs_the_update_clause() {
        let mut bash = fresh();
        let out = run(
            &mut bash,
            "for ((i=0; i<5; i++)); do if [ $((i % 2)) = 1 ]; then continue; fi; echo even-$i; done",
        );
        assert_eq!(out.stdout, "even-0\neven-2\neven-4\n");
    }

    #[test]
    fn break_n_unwinds_n_levels() {
        let mut bash = fresh();
        let out = run(
            &mut bash,
            "for a in 1 2; do for b in x y z; do if [ $b = y ]; then break 2; fi; echo $a$b; done; echo inner-done-$a; done",
        );
        assert_eq!(out.stdout, "1x\n");
    }

    #[test]
    fn break_outside_a_loop_warns_and_succeeds() {
        let mut bash = fresh();
        let out = run(&mut bash, "echo pre; break; echo post");
        assert_eq!(out.exit_code, 0);
        assert!(
            out.stderr.contains("only meaningful in a `for`"),
            "unexpected stderr: {}",
            out.stderr
        );
        assert_eq!(out.stdout, "pre\npost\n");
    }

    #[test]
    fn break_inside_command_substitution_does_not_escape() {
        let mut bash = fresh();
        let out = run(&mut bash, "for i in 1 2; do v=$(break); echo got-$i; done");
        assert_eq!(out.stdout, "got-1\ngot-2\n");
    }

    #[test]
    fn custom_commands_are_discoverable_with_help_and_which() {
        let mut bash = fresh();
        bash.register_command(
            "curl",
            Box::new(|_, _, _| crate::interpreter::CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
            }),
        );

        assert!(
            run(&mut bash, "help")
                .stdout
                .split_whitespace()
                .any(|s| s == "curl")
        );
        assert_eq!(
            run(&mut bash, "help curl").stdout,
            "curl: an available shell command\n"
        );
        assert_eq!(run(&mut bash, "which curl").stdout, "/usr/bin/curl\n");
        assert_eq!(run(&mut bash, "which curl && curl --version").exit_code, 0);
    }

    #[test]
    fn redirect_write_then_read_back() {
        let mut bash = fresh();
        run(&mut bash, "echo hello > /workspace/out.txt");
        let out = run(&mut bash, "cat /workspace/out.txt");
        assert_eq!(out.stdout, "hello\n");
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn redirect_append_accumulates() {
        let mut bash = fresh();
        run(&mut bash, "echo one > log");
        run(&mut bash, "echo two >> log");
        let out = run(&mut bash, "cat log");
        assert_eq!(out.stdout, "one\ntwo\n");
    }

    #[test]
    fn redirect_input_feeds_stdin() {
        let mut bash = fresh();
        run(&mut bash, "echo piped > f");
        let out = run(&mut bash, "cat < f");
        assert_eq!(out.stdout, "piped\n");
    }

    #[test]
    fn quoted_here_document_writes_multiline_file_literally() {
        let mut bash = fresh();
        let out = run(
            &mut bash,
            "cat > /tmp/httpstat.b64 <<'B64EOF'\n\
             Ly8gb2JlbGlzay1hZ2VudDpwcm9ncmFtcy9wcm9ncmFtLmh0dHBzdGF0Ogo=\n\
             B64EOF\n\
             echo \"placeholder test ok\"",
        );
        assert_eq!(out.stdout, "placeholder test ok\n");
        assert_eq!(
            run(&mut bash, "cat /tmp/httpstat.b64").stdout,
            "Ly8gb2JlbGlzay1hZ2VudDpwcm9ncmFtcy9wcm9ncmFtLmh0dHBzdGF0Ogo=\n"
        );
    }

    #[test]
    fn here_document_expansion_respects_delimiter_quoting() {
        let mut bash = fresh();
        run(&mut bash, "NAME=world");
        assert_eq!(
            run(&mut bash, "cat <<EOF\nhello $NAME\nEOF").stdout,
            "hello world\n"
        );
        assert_eq!(
            run(&mut bash, "cat <<'EOF'\nhello $NAME\nEOF").stdout,
            "hello $NAME\n"
        );
    }

    #[test]
    fn unterminated_heredoc_runs_with_whatever_was_collected() {
        let mut bash = fresh();
        // No closing delimiter before the script ends: bash completes the
        // partial final line rather than erroring.
        let r = run(&mut bash, "cat <<EOF\nbody");
        assert_eq!(r.stdout, "body\n");
        assert_eq!(r.exit_code, 0);

        // Nothing at all after the opener.
        let r = run(&mut bash, "cat <<EOF");
        assert_eq!(r.stdout, "");
        assert_eq!(r.exit_code, 0);

        // A trailing unquoted backslash at the cutoff is a continuation with
        // nothing to continue onto, so it (and the newline completing the
        // line) vanish entirely rather than becoming a literal backslash.
        let r = run(&mut bash, "cat <<EOF\nbody\\");
        assert_eq!(r.stdout, "body");
    }

    #[test]
    fn cat_missing_file_reports_error() {
        let mut bash = fresh();
        let out = run(&mut bash, "cat nope.txt");
        assert_eq!(out.exit_code, 1);
        assert!(out.stderr.contains("No such file or directory"));
    }

    #[test]
    fn mkdir_ls_rm_roundtrip() {
        let mut bash = fresh();
        run(&mut bash, "mkdir -p a/b");
        run(&mut bash, "echo x > a/b/file");
        assert_eq!(run(&mut bash, "ls a/b").stdout, "file\n");
        run(&mut bash, "rm -r a");
        let out = run(&mut bash, "ls a");
        assert_eq!(out.exit_code, 1);
        assert!(out.stderr.contains("cannot access"));
    }

    #[test]
    fn redirect_survives_pipeline() {
        let mut bash = fresh();
        run(&mut bash, "echo hi | cat > out");
        assert_eq!(run(&mut bash, "cat out").stdout, "hi\n");
    }

    #[test]
    fn process_substitution_input_feeds_a_file_argument() {
        let mut bash = fresh();
        let out = run(&mut bash, "cat <(echo hi)");
        assert_eq!(out.stdout, "hi\n");
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn process_substitution_input_works_with_multiple_substitutions() {
        let mut bash = fresh();
        let out = run(&mut bash, "diff <(echo a) <(echo b)");
        assert_eq!(out.exit_code, 1);
        assert!(out.stdout.contains("-a"));
        assert!(out.stdout.contains("+b"));
    }

    #[test]
    fn process_substitution_output_receives_what_is_written_to_it() {
        let mut bash = fresh();
        run(&mut bash, "echo out | tee >(cat > sink) > /dev/null");
        assert_eq!(run(&mut bash, "cat sink").stdout, "out\n");
    }

    #[test]
    fn subshell_isolates_variable_and_directory_mutations() {
        let mut bash = fresh();
        run(&mut bash, "mkdir -p /tmp");
        let start_cwd = run(&mut bash, "pwd").stdout;
        let out = run(
            &mut bash,
            r#"X=outer; (X=inner; cd /tmp; echo "in:$X:$PWD"); echo "out:$X:$PWD""#,
        );
        assert_eq!(
            out.stdout,
            format!("in:inner:/tmp\nout:outer:{}", start_cwd)
        );
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn subshell_composes_its_stdout_in_a_pipeline() {
        let mut bash = fresh();
        let out = run(&mut bash, "(echo a; echo b) | cat");
        assert_eq!(out.stdout, "a\nb\n");
    }

    #[test]
    fn subshell_exit_code_is_its_last_command() {
        let mut bash = fresh();
        let out = run(&mut bash, "(true; false); echo \"status:$?\"");
        assert_eq!(out.stdout, "status:1\n");
    }

    #[test]
    fn subshell_break_does_not_escape_to_an_enclosing_loop() {
        let mut bash = fresh();
        let out = run(
            &mut bash,
            r#"for i in 1 2 3; do ( [ "$i" = 2 ] && break ); echo "i:$i"; done"#,
        );
        assert_eq!(out.stdout, "i:1\ni:2\ni:3\n");
    }

    #[test]
    fn group_shares_the_enclosing_shells_variables_and_directory() {
        let mut bash = fresh();
        run(&mut bash, "mkdir -p /tmp");
        let out = run(
            &mut bash,
            r#"X=outer; { X=inner; cd /tmp; echo "in:$X:$PWD"; }; echo "out:$X:$PWD""#,
        );
        assert_eq!(out.stdout, "in:inner:/tmp\nout:inner:/tmp\n");
    }

    #[test]
    fn group_break_reaches_an_enclosing_loop() {
        let mut bash = fresh();
        // Unlike a subshell, a group's `break` unwinds the enclosing `for`
        // immediately, so the `echo` after the group for i=2 never runs.
        let out = run(
            &mut bash,
            r#"for i in 1 2 3; do { [ "$i" = 2 ] && break; }; echo "i:$i"; done"#,
        );
        assert_eq!(out.stdout, "i:1\n");
    }

    #[test]
    fn case_pattern_optional_wrapping_parens_still_work() {
        let mut bash = fresh();
        let out = run(&mut bash, "case foo in ( foo|bar ) echo P;; esac");
        assert_eq!(out.stdout, "P\n");
    }

    #[test]
    fn redirect_stdout_to_stderr() {
        let mut bash = fresh();
        for script in ["echo hi >&2", "echo hi 1>&2"] {
            let out = run(&mut bash, script);
            assert_eq!(out.stdout, "", "{script}");
            assert_eq!(out.stderr, "hi\n", "{script}");
            assert_eq!(out.exit_code, 0, "{script}");
        }
    }

    #[test]
    fn redirect_stderr_to_stdout_merges() {
        let mut bash = fresh();
        // `2>&1` folds the command's stderr into its stdout (and leaves the
        // shell's stderr empty), so a pipeline can capture both streams.
        let out = run(&mut bash, "ls /nope 2>&1");
        assert_eq!(out.stderr, "");
        assert!(
            out.stdout.contains("cannot access"),
            "stdout={:?}",
            out.stdout
        );
    }

    #[test]
    fn redirect_stderr_to_a_file() {
        let mut bash = fresh();
        run(&mut bash, "echo keep > f");
        // `2>f` truncates f up front, even though echo writes nothing to stderr.
        run(&mut bash, "echo hello 2>f");
        assert_eq!(run(&mut bash, "cat f").stdout, "");
        run(&mut bash, "ls /nope 2>f");
        assert!(run(&mut bash, "cat f").stdout.contains("cannot access"));
    }

    #[test]
    fn redirect_both_streams_to_one_file() {
        let mut bash = fresh();
        // `> f 2>&1`: fd2 follows fd1 to the file, so the error lands in f.
        run(&mut bash, "ls /nope > f 2>&1");
        assert!(run(&mut bash, "cat f").stdout.contains("cannot access"));
    }

    #[test]
    fn redirections_apply_transactionally_left_to_right() {
        let mut bash = fresh();
        // `> out` truncates/creates `out` as it's parsed, before the later
        // `< nosuch` fails -- bash processes redirections in source order and
        // does not roll back earlier ones when a later one fails.
        run(&mut bash, "echo keep > out");
        let cmd_result = run(&mut bash, "cat > out < nosuch");
        assert_eq!(cmd_result.exit_code, 1);
        assert!(cmd_result.stderr.contains("No such file or directory"));
        assert_eq!(run(&mut bash, "cat out").stdout, "");

        // The opposite order: the failing `<` comes first, so the `>` target
        // is never reached and is left untouched.
        run(&mut bash, "echo keep > out2");
        let cmd_result = run(&mut bash, "cat < nosuch > out2");
        assert_eq!(cmd_result.exit_code, 1);
        assert_eq!(run(&mut bash, "cat out2").stdout, "keep\n");
    }

    #[test]
    fn run_script_by_path_requires_execute_bit() {
        let mut bash = fresh();
        run(&mut bash, "printf %s 'echo hi' > x.sh");
        // Without the execute bit, a path invocation is Permission denied.
        let denied = run(&mut bash, "./x.sh");
        assert_eq!(denied.exit_code, 126);
        assert!(
            denied.stderr.contains("Permission denied"),
            "stderr={:?}",
            denied.stderr
        );
        // `chmod +x` then run.
        run(&mut bash, "chmod +x x.sh");
        assert_eq!(run(&mut bash, "./x.sh").stdout, "hi\n");
        assert_eq!(run(&mut bash, "/workspace/x.sh").stdout, "hi\n");
    }

    #[test]
    fn run_missing_path_script_is_not_found() {
        let mut bash = fresh();
        let out = run(&mut bash, "./nope.sh");
        assert_eq!(out.exit_code, 127);
        assert!(out.stderr.contains("No such file or directory"));
    }

    #[test]
    fn sh_and_bash_run_a_script_file_without_execute_bit() {
        let mut bash = fresh();
        run(&mut bash, "printf %s 'echo ran' > x.sh");
        assert_eq!(run(&mut bash, "sh x.sh").stdout, "ran\n");
        assert_eq!(run(&mut bash, "bash x.sh").stdout, "ran\n");
        assert_eq!(run(&mut bash, "sh -c 'echo dashc'").stdout, "dashc\n");
    }

    #[test]
    fn source_runs_in_current_shell_but_sh_isolates() {
        let mut bash = fresh();
        run(&mut bash, "printf %s 'X=42' > vars.sh");
        // `source`/`.` assignments persist in the caller.
        run(&mut bash, "source vars.sh");
        assert_eq!(run(&mut bash, "echo $X").stdout, "42\n");
        // A subshell (`sh`) assignment does not leak back.
        run(&mut bash, "printf %s 'Y=9' > y.sh");
        run(&mut bash, "sh y.sh");
        assert_eq!(run(&mut bash, "echo [$Y]").stdout, "[]\n");
    }

    #[test]
    fn path_script_receives_positional_params() {
        let mut bash = fresh();
        run(
            &mut bash,
            "printf '%s\\n' 'echo n=$#' 'echo 1=$1 2=$2' 'echo 0=$0' > s.sh; chmod +x s.sh",
        );
        let out = run(&mut bash, "./s.sh a b c").stdout;
        assert_eq!(out, "n=3\n1=a 2=b\n0=./s.sh\n");
        // The caller's own params are untouched by the isolated run.
        assert_eq!(run(&mut bash, "echo [$#]").stdout, "[0]\n");
    }

    #[test]
    fn sh_dashc_sets_arg0_then_params() {
        let mut bash = fresh();
        // `sh -c SRC name a b`: name is $0, a/b are $1/$2.
        let out = run(&mut bash, "sh -c 'echo $0 $#: $1 $2' prog x y").stdout;
        assert_eq!(out, "prog 2: x y\n");
    }

    #[test]
    fn quoted_at_keeps_each_param_a_separate_word() {
        let mut bash = fresh();
        run(
            &mut bash,
            "printf '%s\\n' 'for a in \"$@\"; do echo [$a]; done' > s.sh; chmod +x s.sh",
        );
        // "y y" stays one argument; unquoted it would split into two.
        assert_eq!(run(&mut bash, "./s.sh x 'y y'").stdout, "[x]\n[y y]\n");
        run(
            &mut bash,
            "printf '%s\\n' 'for a in $*; do echo [$a]; done' > u.sh; chmod +x u.sh",
        );
        assert_eq!(run(&mut bash, "./u.sh x 'y y'").stdout, "[x]\n[y]\n[y]\n");
    }

    #[test]
    fn shift_drops_leading_params() {
        let mut bash = fresh();
        run(
            &mut bash,
            "printf '%s\\n' 'shift; echo $1 $#' 'shift 5; echo done $?' > s.sh; chmod +x s.sh",
        );
        // shift moves $2 into $1; shifting past the end is a no-op returning 1.
        assert_eq!(run(&mut bash, "./s.sh a b c").stdout, "b 2\ndone 1\n");
    }

    #[test]
    fn set_dashdash_replaces_positional_params() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "set -- a b c; echo $# $2").stdout, "3 b\n");
        // Options-only `set` leaves params alone; `set --` clears them.
        assert_eq!(run(&mut bash, "set -- a b; set -e; echo $#").stdout, "2\n");
        assert_eq!(run(&mut bash, "set -- a b; set --; echo $#").stdout, "0\n");
    }

    #[test]
    fn source_with_args_scopes_params_to_the_sourced_script() {
        let mut bash = fresh();
        run(&mut bash, "printf %s 'echo sourced $1 $#' > s.sh");
        run(&mut bash, "set -- outer");
        assert_eq!(run(&mut bash, "source s.sh a b").stdout, "sourced a 2\n");
        // A bare `source` (no args) keeps the caller's params.
        assert_eq!(run(&mut bash, "source s.sh").stdout, "sourced outer 1\n");
    }

    #[test]
    fn ls_long_format_lists_mode_size_and_total() {
        let mut bash = fresh();
        run(&mut bash, "printf hello > f.txt; mkdir sub");
        let out = run(&mut bash, "ls -l").stdout;
        assert!(out.starts_with("total 2\n"), "{out:?}");
        assert!(
            out.contains("-rw-r--r-- 1 user user     5 Jan  1 00:00 f.txt\n"),
            "{out:?}"
        );
        assert!(
            out.contains("drwxr-xr-x 1 user user     0 Jan  1 00:00 sub\n"),
            "{out:?}"
        );
    }

    #[test]
    fn oversized_lazy_file_uses_metadata_without_fetching() {
        struct NoFetch;
        impl crate::fs::BlobLoader for NoFetch {
            fn load(&self, digest: &str) -> Result<Vec<u8>, String> {
                panic!("must not fetch {digest}");
            }
        }

        let mut bash = fresh();
        bash.fs_mut().set_blob_loader(std::rc::Rc::new(NoFetch));
        bash.fs_mut()
            .register_lazy("/component.wasm", "sha256:abc", 9_984_695);

        let cat = run(&mut bash, "cat /component.wasm");
        assert_eq!(cat.stdout, "<application/wasm, sha256:abc, 9.5 MB>\n");
        assert_eq!(cat.exit_code, 1);
        assert!(
            run(&mut bash, "ls -l /component.wasm")
                .stdout
                .contains("9984695")
        );
        assert_eq!(
            run(&mut bash, "stat -c %s /component.wasm").stdout,
            "9984695\n"
        );
        assert_eq!(
            run(&mut bash, "du -h /component.wasm").stdout,
            "9.5M\t/component.wasm\n"
        );
        assert_eq!(
            run(&mut bash, "file -i /component.wasm").stdout,
            "/component.wasm: application/wasm\n"
        );
    }

    #[test]
    fn ls_hides_dotfiles_unless_all_flag() {
        let mut bash = fresh();
        run(&mut bash, "touch .hidden vis");
        assert_eq!(run(&mut bash, "ls").stdout, "vis\n");
        assert_eq!(run(&mut bash, "ls -a").stdout, ".\n..\n.hidden\nvis\n");
    }

    #[test]
    fn ls_multiple_dirs_separated_by_blank_line() {
        let mut bash = fresh();
        run(&mut bash, "mkdir -p d1 d2; touch d1/a d2/b");
        let out = run(&mut bash, "ls d1 d2").stdout;
        // Each directory's listing is headed and separated by a blank line.
        assert!(out.contains("d1:\na\n\n"), "{out:?}");
        assert!(out.trim_end().ends_with("d2:\nb"), "{out:?}");
    }

    #[test]
    fn ls_and_tree_sort_case_insensitively_lowercase_first() {
        let mut bash = fresh();
        // localeCompare order: `a`, `A`, `b` (not raw-ASCII `A`, `a`, `b`).
        run(&mut bash, "touch b a A");
        assert_eq!(run(&mut bash, "ls").stdout, "a\nA\nb\n");
        run(&mut bash, "mkdir d; touch d/b d/a d/A");
        let tree = run(&mut bash, "tree d").stdout;
        let names: Vec<&str> = tree
            .lines()
            .skip(1)
            .take(3)
            .map(|l| l.trim_start_matches(['|', ' ', '`', '-']))
            .collect();
        assert_eq!(names, vec!["a", "A", "b"]);
    }

    #[test]
    fn set_pipefail_reports_failing_pipeline_stage() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "false | true; echo $?").stdout, "0\n");
        assert_eq!(
            run(&mut bash, "set -o pipefail; false | true; echo $?").stdout,
            "1\n"
        );
        // The option persists to the next exec (session state on `Bash`).
        assert_eq!(run(&mut bash, "true | false | true; echo $?").stdout, "1\n");
        assert_eq!(
            run(&mut bash, "set +o pipefail; false | true; echo $?").stdout,
            "0\n"
        );
    }

    #[test]
    fn set_errexit_stops_on_failure_with_the_usual_exceptions() {
        let mut bash = fresh();
        let out = run(&mut bash, "set -e; false; echo NOPE");
        assert_eq!(out.exit_code, 1);
        assert!(!out.stdout.contains("NOPE"));
        // A tested command (condition, `&&`/`||`, `!`) does not trip errexit.
        let mut bash = fresh();
        assert_eq!(
            run(
                &mut bash,
                "set -e; if false; then :; fi; false || true; false && :; ! true; echo done"
            )
            .stdout,
            "done\n"
        );
    }

    #[test]
    fn set_nounset_errors_on_unset_variable() {
        let mut bash = fresh();
        let out = run(&mut bash, "set -u; echo [$UNSET]; echo NOPE");
        assert_eq!(out.exit_code, 1);
        assert!(out.stderr.contains("UNSET: unbound variable"));
        assert!(!out.stdout.contains("NOPE"));
    }

    #[test]
    fn set_xtrace_prints_commands_to_stderr() {
        let mut bash = fresh();
        let out = run(&mut bash, "set -x; echo hi");
        assert_eq!(out.stdout, "hi\n");
        assert!(out.stderr.contains("+ echo hi"), "stderr={:?}", out.stderr);
    }

    #[test]
    fn command_substitution_splices_output() {
        let mut bash = fresh();
        let out = run(&mut bash, "echo start-$(echo mid)-end");
        assert_eq!(out.stdout, "start-mid-end\n");
    }

    #[test]
    fn command_substitution_in_assignment() {
        let mut bash = fresh();
        run(&mut bash, "X=$(echo hello | cat)");
        assert_eq!(run(&mut bash, "echo $X").stdout, "hello\n");
    }

    #[test]
    fn backtick_command_substitution() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "echo `echo hi`").stdout, "hi\n");
    }

    #[test]
    fn if_then_else_selects_branch() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "if true; then echo yes; fi").stdout, "yes\n");
        assert_eq!(
            run(&mut bash, "if false; then echo yes; else echo no; fi").stdout,
            "no\n"
        );
    }

    #[test]
    fn if_uses_test_on_a_file() {
        let mut bash = fresh();
        run(&mut bash, "echo hi > /workspace/f");
        let out = run(
            &mut bash,
            "if [ -f /workspace/f ]; then echo present; else echo missing; fi",
        );
        assert_eq!(out.stdout, "present\n");
    }

    #[test]
    fn elif_chain() {
        let mut bash = fresh();
        run(&mut bash, "X=2");
        let out = run(
            &mut bash,
            "if [ $X = 1 ]; then echo one; elif [ $X = 2 ]; then echo two; else echo other; fi",
        );
        assert_eq!(out.stdout, "two\n");
    }

    #[test]
    fn for_loop_iterates_items() {
        let mut bash = fresh();
        let out = run(&mut bash, "for i in a b c; do echo $i; done");
        assert_eq!(out.stdout, "a\nb\nc\n");
    }

    #[test]
    fn for_loop_over_command_substitution_pipes_out() {
        let mut bash = fresh();
        let out = run(&mut bash, "for i in a b; do echo $i; done | cat");
        assert_eq!(out.stdout, "a\nb\n");
    }

    #[test]
    fn c_style_for_loop_iterates() {
        let mut bash = fresh();
        // The `;`-separated header used to be eaten by the single-expression
        // arithmetic lexer and rejected with "syntax error near `; i<=5; i++`".
        let out = run(
            &mut bash,
            "for ((i=1; i<=5; i++)); do echo \"Iteration $i\"; done",
        );
        assert_eq!(
            out.stdout,
            "Iteration 1\nIteration 2\nIteration 3\nIteration 4\nIteration 5\n"
        );
        assert_eq!(out.exit_code, 0);
        // The loop variable keeps its final post-increment value, as in bash.
        assert_eq!(run(&mut bash, "echo $i").stdout, "6\n");
    }

    #[test]
    fn while_loop_runs_until_condition_false() {
        let mut bash = fresh();
        run(&mut bash, "echo go > /workspace/loop");
        // The body removes the sentinel file, so the guard fails on the next pass.
        let out = run(
            &mut bash,
            "while [ -f /workspace/loop ]; do echo tick; rm /workspace/loop; done",
        );
        assert_eq!(out.stdout, "tick\n");
    }

    #[test]
    fn until_loop_runs_until_condition_true() {
        let mut bash = fresh();
        run(&mut bash, "touch /workspace/flag");
        // The condition is true immediately, so an `until` body never runs.
        let out = run(
            &mut bash,
            "until [ -f /workspace/flag ]; do echo never; done",
        );
        assert_eq!(out.stdout, "");
    }

    #[test]
    fn if_condition_reads_last_status() {
        let mut bash = fresh();
        let out = run(&mut bash, "if echo hi; then echo ran; fi");
        assert_eq!(out.stdout, "hi\nran\n");
    }

    // The script-watch contract from the session loop's perspective: signals land
    // only at durable boundaries, output already produced stays recorded, and the
    // final status is the interrupt kind's exit code.
    mod script_watch {
        use super::*;
        use crate::interpreter::CommandOutput;
        use crate::watch::{InterruptKind, ScriptWatch};

        /// Scripted watcher: fires on the Nth poll (1-based, custom commands only)
        /// and/or on every watched sleep.
        struct FakeWatch {
            interrupt_on_poll: Option<usize>,
            interrupt_sleeps: bool,
            polls: usize,
            slept_ms: Vec<u64>,
        }

        impl FakeWatch {
            fn silent() -> Self {
                Self {
                    interrupt_on_poll: None,
                    interrupt_sleeps: false,
                    polls: 0,
                    slept_ms: Vec::new(),
                }
            }
        }

        impl ScriptWatch for FakeWatch {
            fn poll(&mut self) -> Option<InterruptKind> {
                self.polls += 1;
                if self.interrupt_on_poll == Some(self.polls) {
                    Some(InterruptKind::Timeout)
                } else {
                    None
                }
            }

            fn sleep(&mut self, ms: u64) -> Result<(), InterruptKind> {
                self.slept_ms.push(ms);
                if self.interrupt_sleeps {
                    Err(InterruptKind::Operator)
                } else {
                    Ok(())
                }
            }
        }

        fn run_with(script: &str, watch: &Rc<RefCell<FakeWatch>>) -> ExecResult {
            let mut bash = fresh();
            let handler: crate::custom_command::CustomCommandHandler =
                Box::new(|_, _, _| CommandOutput {
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: 0,
                });
            bash.register_command("step", handler);
            bash.set_script_watch(Some(watch.clone()));
            bash.exec(script, ExecOptions::default())
        }

        #[test]
        fn poll_at_a_command_boundary_skips_only_what_follows() {
            let watch = Rc::new(RefCell::new(FakeWatch {
                interrupt_on_poll: Some(2),
                interrupt_sleeps: false,
                polls: 0,
                slept_ms: Vec::new(),
            }));
            let out = run_with("step; echo one; step; echo two; echo three", &watch);
            // Output collected before the signal stands; everything after the
            // second boundary is gone.
            assert_eq!(out.stdout, "one\n");
            assert_eq!(out.exit_code, 124);
            assert_eq!(out.interrupted, Some(InterruptKind::Timeout));
            assert_eq!(out.stderr, "");
        }

        #[test]
        fn watched_sleep_wakes_early_and_ends_the_script() {
            let watch = Rc::new(RefCell::new(FakeWatch {
                interrupt_on_poll: None,
                interrupt_sleeps: true,
                polls: 0,
                slept_ms: Vec::new(),
            }));
            let out = run_with("sleep 5; echo after", &watch);
            assert_eq!(out.stdout, "");
            assert_eq!(out.exit_code, 130);
            assert_eq!(out.interrupted, Some(InterruptKind::Operator));
            assert!(
                out.stderr.contains("sleep: interrupted (operator)"),
                "{}",
                out.stderr
            );
            // The delay reached the watch with its full duration; waking early is
            // the watch's business.
            assert_eq!(watch.borrow().slept_ms, vec![5000]);
        }

        #[test]
        fn interrupted_run_overrides_the_last_statement_status() {
            let watch = Rc::new(RefCell::new(FakeWatch {
                interrupt_on_poll: None,
                interrupt_sleeps: true,
                polls: 0,
                slept_ms: Vec::new(),
            }));
            let out = run_with("false; sleep 5", &watch);
            // Without `set -e` the failed `false` would leave exit 1; the
            // interrupt code wins.
            assert_eq!(out.exit_code, 130);
        }

        #[test]
        fn natural_completion_records_no_marker() {
            let watch = Rc::new(RefCell::new(FakeWatch::silent()));
            let out = run_with("step; echo done; step", &watch);
            assert_eq!(out.stdout, "done\n");
            assert_eq!(out.exit_code, 0);
            assert_eq!(out.interrupted, None);
            // One peek per host-backed command.
            assert_eq!(watch.borrow().polls, 2);
        }

        #[test]
        fn unset_watch_keeps_plain_sleep_semantics() {
            let mut bash = fresh();
            let out = bash.exec("sleep 0; echo fine", ExecOptions::default());
            assert_eq!(out.stdout, "fine\n");
            assert_eq!(out.interrupted, None);
        }
    }

    // PORT: vendor/just-bash/src/spec-tests/bash/cases/word-split.test.sh
    // ("Word splitting" / "Word splitting 2"). Upstream visualizes fields with
    // `argv.py`; there's no argv-dump builtin here, so a `for` loop over the
    // same word prints one field per line instead, which is an equivalent
    // observation of the field boundaries. The `$*`/`$@`/positional-parameter
    // cases in that file are out of scope (no positional params, a documented
    // simplification) and are not ported.
    mod word_splitting {
        use super::*;

        #[test]
        fn unquoted_and_quoted_expansions_join_at_field_boundaries() {
            let mut bash = fresh();
            let out = run(
                &mut bash,
                r#"a="1 2"; b="3 4"; for w in $a"$b"; do echo "[$w]"; done"#,
            );
            assert_eq!(out.stdout, "[1]\n[23 4]\n");
        }

        #[test]
        fn multiple_adjacent_expansions_join_across_the_boundary() {
            let mut bash = fresh();
            let out = run(
                &mut bash,
                r#"a="1 2"; b="3 4"; c="5 6"; d="7 8"; for w in $a"$b"$c"$d"; do echo "[$w]"; done"#,
            );
            assert_eq!(out.stdout, "[1]\n[23 45]\n[67 8]\n");
        }

        #[test]
        fn unquoted_unset_variable_contributes_no_argument() {
            let mut bash = fresh();
            // `echo` alone; if the empty expansion produced a field the count
            // would differ from a plain `echo`'s single trailing newline.
            let out = run(&mut bash, "unset x; echo start$x end");
            assert_eq!(out.stdout, "start end\n");
            let out = run(&mut bash, "unset x; echo $x");
            assert_eq!(out.stdout, "\n");
        }

        #[test]
        fn lone_dollar_is_a_literal_dollar_sign() {
            // A `$` that starts no expansion stays literal (matching bash), so
            // commands like `chat create $ ls` receive it as an argument.
            let mut bash = fresh();
            let out = run(&mut bash, r#"printf '[%s]' $ hello"#);
            assert_eq!(out.stdout, "[$][hello]");
            let out = run(&mut bash, "x=$; echo $x");
            assert_eq!(out.stdout, "$\n");
        }

        #[test]
        fn quoted_empty_variable_is_one_empty_argument() {
            let mut bash = fresh();
            let out = run(&mut bash, r#"unset x; if [ -z "$x" ]; then echo empty; fi"#);
            assert_eq!(out.stdout, "empty\n");
        }

        #[test]
        fn custom_ifs_splits_on_its_own_characters() {
            let mut bash = fresh();
            let out = run(
                &mut bash,
                r#"IFS=:; x="a:b:c"; for w in $x; do echo "[$w]"; done"#,
            );
            assert_eq!(out.stdout, "[a]\n[b]\n[c]\n");
        }
    }

    // PORT (simplified, no filesystem-based glob crate; see glob.rs docs):
    // functional pathname-expansion behavior the design doc calls for -
    // matches sorted, no match passes the word through literally.
    mod globbing {
        use super::*;

        #[test]
        fn star_expands_to_sorted_matching_filenames() {
            let mut bash = fresh();
            run(&mut bash, "touch b.txt a.txt c.log");
            let out = run(&mut bash, "for f in *.txt; do echo $f; done");
            assert_eq!(out.stdout, "a.txt\nb.txt\n");
        }

        #[test]
        fn no_match_passes_the_word_through_literally() {
            let mut bash = fresh();
            let out = run(&mut bash, "echo *.missing");
            assert_eq!(out.stdout, "*.missing\n");
        }

        #[test]
        fn question_and_bracket_class_match() {
            let mut bash = fresh();
            run(&mut bash, "touch a1 a2 b1");
            let out = run(&mut bash, "for f in a?; do echo $f; done");
            assert_eq!(out.stdout, "a1\na2\n");
            let out = run(&mut bash, "for f in [ab]1; do echo $f; done");
            assert_eq!(out.stdout, "a1\nb1\n");
        }

        #[test]
        fn quoted_glob_characters_are_literal() {
            let mut bash = fresh();
            run(&mut bash, "touch a.txt");
            let out = run(&mut bash, r#"echo "*.txt""#);
            assert_eq!(out.stdout, "*.txt\n");
        }
    }

    // PORT: vendor/just-bash/src/interpreter/arithmetic.test.ts. Array-element
    // arithmetic (`arr[i]`) is not ported: this AST has no arrays (a design-doc
    // simplification out of scope for this phase), so those three upstream
    // cases are dropped. Everything else in that suite is ported below,
    // grouped the same way as the upstream `describe` blocks.
    mod arithmetic_expansion {
        use super::*;

        #[test]
        fn binary_operators() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "echo $((5 + 3))").stdout, "8\n");
            assert_eq!(run(&mut bash, "echo $((10 - 4))").stdout, "6\n");
            assert_eq!(run(&mut bash, "echo $((6 * 7))").stdout, "42\n");
            assert_eq!(run(&mut bash, "echo $((20 / 4))").stdout, "5\n");
            assert_eq!(run(&mut bash, "echo $((7 / 2))").stdout, "3\n");
            assert_eq!(run(&mut bash, "echo $((17 % 5))").stdout, "2\n");
            assert_eq!(run(&mut bash, "echo $((2 ** 10))").stdout, "1024\n");
            assert_eq!(run(&mut bash, "echo $((1 << 8))").stdout, "256\n");
            assert_eq!(run(&mut bash, "echo $((256 >> 4))").stdout, "16\n");
            assert_eq!(run(&mut bash, "echo $((12 & 10))").stdout, "8\n");
            assert_eq!(run(&mut bash, "echo $((12 | 10))").stdout, "14\n");
            assert_eq!(run(&mut bash, "echo $((12 ^ 10))").stdout, "6\n");
            assert_eq!(run(&mut bash, "echo $((1, 2, 3))").stdout, "3\n");
        }

        #[test]
        fn comparison_operators() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "echo $((3 < 5)) $((5 < 3))").stdout, "1 0\n");
            assert_eq!(
                run(&mut bash, "echo $((3 <= 3)) $((4 <= 3))").stdout,
                "1 0\n"
            );
            assert_eq!(run(&mut bash, "echo $((5 > 3)) $((3 > 5))").stdout, "1 0\n");
            assert_eq!(
                run(&mut bash, "echo $((3 >= 3)) $((2 >= 3))").stdout,
                "1 0\n"
            );
            assert_eq!(
                run(&mut bash, "echo $((5 == 5)) $((5 == 6))").stdout,
                "1 0\n"
            );
            assert_eq!(
                run(&mut bash, "echo $((5 != 6)) $((5 != 5))").stdout,
                "1 0\n"
            );
        }

        #[test]
        fn logical_operators() {
            let mut bash = fresh();
            assert_eq!(
                run(&mut bash, "echo $((1 && 1)) $((1 && 0)) $((0 && 1))").stdout,
                "1 0 0\n"
            );
            assert_eq!(
                run(&mut bash, "echo $((1 || 0)) $((0 || 1)) $((0 || 0))").stdout,
                "1 1 0\n"
            );
            let out = run(&mut bash, "x=5; echo $((0 && (x=10))); echo $x");
            assert_eq!(out.stdout, "0\n5\n");
            let out = run(&mut bash, "x=5; echo $((1 || (x=10))); echo $x");
            assert_eq!(out.stdout, "1\n5\n");
            assert_eq!(
                run(&mut bash, "echo $((!0)) $((!1)) $((!5))").stdout,
                "1 0 0\n"
            );
        }

        #[test]
        fn unary_operators() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "echo $((-5))").stdout, "-5\n");
            assert_eq!(run(&mut bash, "echo $((+5))").stdout, "5\n");
            assert_eq!(run(&mut bash, "echo $((~0))").stdout, "-1\n");
            assert_eq!(
                run(&mut bash, "x=5; echo $((++x)); echo $x").stdout,
                "6\n6\n"
            );
            assert_eq!(
                run(&mut bash, "x=5; echo $((x++)); echo $x").stdout,
                "5\n6\n"
            );
            assert_eq!(
                run(&mut bash, "x=5; echo $((--x)); echo $x").stdout,
                "4\n4\n"
            );
            assert_eq!(
                run(&mut bash, "x=5; echo $((x--)); echo $x").stdout,
                "5\n4\n"
            );
        }

        #[test]
        fn ternary_operator() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "echo $((1 ? 10 : 20))").stdout, "10\n");
            assert_eq!(run(&mut bash, "echo $((0 ? 10 : 20))").stdout, "20\n");
            assert_eq!(run(&mut bash, "echo $((1 ? 2 ? 3 : 4 : 5))").stdout, "3\n");
        }

        #[test]
        fn assignment_operators() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "echo $((x = 5)); echo $x").stdout, "5\n5\n");
            assert_eq!(
                run(&mut bash, "x=10; echo $((x += 5)); echo $x").stdout,
                "15\n15\n"
            );
            assert_eq!(
                run(&mut bash, "x=10; echo $((x -= 3)); echo $x").stdout,
                "7\n7\n"
            );
            assert_eq!(
                run(&mut bash, "x=4; echo $((x *= 3)); echo $x").stdout,
                "12\n12\n"
            );
            assert_eq!(
                run(&mut bash, "x=20; echo $((x /= 4)); echo $x").stdout,
                "5\n5\n"
            );
            assert_eq!(
                run(&mut bash, "x=17; echo $((x %= 5)); echo $x").stdout,
                "2\n2\n"
            );
            assert_eq!(
                run(&mut bash, "x=2; echo $((x <<= 3)); echo $x").stdout,
                "16\n16\n"
            );
            assert_eq!(
                run(&mut bash, "x=32; echo $((x >>= 2)); echo $x").stdout,
                "8\n8\n"
            );
            assert_eq!(
                run(&mut bash, "x=12; echo $((x &= 10)); echo $x").stdout,
                "8\n8\n"
            );
            assert_eq!(
                run(&mut bash, "x=12; echo $((x |= 1)); echo $x").stdout,
                "13\n13\n"
            );
            assert_eq!(
                run(&mut bash, "x=12; echo $((x ^= 5)); echo $x").stdout,
                "9\n9\n"
            );
        }

        #[test]
        fn error_cases() {
            let mut bash = fresh();
            let out = run(&mut bash, "echo $((5 / 0))");
            assert!(out.stderr.contains("division by 0"));
            assert_eq!(out.exit_code, 1);
            let out = run(&mut bash, "echo $((5 % 0))");
            assert!(out.stderr.contains("division by 0"));
            assert_eq!(out.exit_code, 1);
            let out = run(&mut bash, "echo $((2 ** -1))");
            assert!(out.stderr.contains("exponent less than 0"));
            assert_eq!(out.exit_code, 1);
        }

        #[test]
        fn variable_references() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "x=5; echo $((x + 3))").stdout, "8\n");
            assert_eq!(run(&mut bash, "x=5; echo $(($x + 3))").stdout, "8\n");
            assert_eq!(run(&mut bash, "echo $((unset_var + 5))").stdout, "5\n");
            assert_eq!(run(&mut bash, "a=5; b=a; echo $((b))").stdout, "5\n");
            assert_eq!(run(&mut bash, "e='1+2'; echo $((e + 3))").stdout, "6\n");
        }

        #[test]
        fn nested_expressions() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "echo $((2 * (3 + 4)))").stdout, "14\n");
            assert_eq!(run(&mut bash, "echo $(( (1 + 2) * 3 + 4 ))").stdout, "13\n");
            assert_eq!(run(&mut bash, "echo $((2 + 3 * 4))").stdout, "14\n");
        }

        #[test]
        fn number_bases() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "echo $((010))").stdout, "8\n");
            assert_eq!(run(&mut bash, "echo $((0xFF))").stdout, "255\n");
            assert_eq!(run(&mut bash, "echo $((2#1010))").stdout, "10\n");
            assert_eq!(run(&mut bash, "echo $((16#ff))").stdout, "255\n");
        }

        #[test]
        fn arithmetic_command() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "(( 5 )); echo $?").stdout, "0\n");
            assert_eq!(run(&mut bash, "(( 0 )); echo $?").stdout, "1\n");
            let out = run(&mut bash, "(( x = 5 + 3 )); echo $x");
            assert_eq!(out.stdout, "8\n");
        }
    }
}
