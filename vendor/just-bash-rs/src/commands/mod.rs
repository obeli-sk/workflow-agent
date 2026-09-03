//! PORT: vendor/just-bash/src/commands/ and src/interpreter/builtins/
//!
//! The command catalog. `command_names` is the registry surface the workflow
//! filters over; `dispatch` is the single match statement wiring argv[0] to a
//! handler. This module holds the original minimal-shell builtins (echo, pwd,
//! cd, export/unset, cat, mkdir, ls, rm, touch, test/[) plus the shared
//! helpers (`ok`/`fail`/`split_flags`/`normalize_path`) reused by the coreutils
//! ported on demand (design doc phase 3), which each live in their own
//! sibling module: `text` (wc/head/tail/cut/tr/printf/basename/dirname),
//! `grep`, `sed`, `sort_uniq`, `xargs`, `find`.

use std::collections::BTreeMap;

use crate::fs::{FileReadError, FsError, LazyOrigin};
use crate::interpreter::{CommandOutput, Interpreter, LoopControl};

mod awk;
mod diff;
mod find;
mod fsutil;
mod grep;
mod hash;
pub(crate) use hash::sha256_hex;
mod jq;
mod misc;
mod sed;
mod sort_uniq;
mod text;
mod textutil2;
mod timeutil;
mod xargs;

#[rustfmt::skip]
const BUILTINS: &[&str] = &[
    "echo", "pwd", "cd", "true", "false", ":", "export", "unset", "read", "cat", "mkdir", "ls", "stat",
    "rm", "touch", "test", "[", "grep", "egrep", "fgrep", "sed", "wc", "sort", "uniq", "head",
    "tail", "cut", "tr", "printf", "xargs", "find", "basename", "dirname", "jq", "awk", "date",
    "expr", "sleep", "timeout", "time", "seq", "tee", "which", "env", "printenv", "whoami",
    "hostname", "alias", "unalias", "help", "clear", "base64", "md5sum", "sha256sum", "diff", "cp", "mv",
    "rmdir", "chmod", "readlink", "ln", "file", "du", "tree", "comm", "join", "nl", "od", "rev",
    "fold", "expand", "unexpand", "column", "paste", "strings", "split", "sh", "bash", "source",
    ".", "set", "shift", "break", "continue",
];

/// Names of the available commands. The workflow filters this list.
pub fn command_names() -> Vec<&'static str> {
    BUILTINS.to_vec()
}

fn ok(stdout: String) -> CommandOutput {
    CommandOutput {
        stdout,
        stderr: String::new(),
        exit_code: 0,
    }
}

fn fail(stderr: String, exit_code: i32) -> CommandOutput {
    CommandOutput {
        stdout: String::new(),
        stderr,
        exit_code,
    }
}

fn builtin_read(interp: &mut Interpreter, args: &[String], stdin: String) -> CommandOutput {
    if stdin.is_empty() {
        return fail(String::new(), 1);
    }
    let (flags, names) = split_flags(args);
    let targets = if names.is_empty() {
        vec!["REPLY"]
    } else {
        names.into_iter().map(String::as_str).collect()
    };
    let (line, remainder, complete) = match stdin.find('\n') {
        Some(newline) => (&stdin[..newline], &stdin[newline + 1..], true),
        None => (stdin.as_str(), "", false),
    };
    if let Some(binding) = &interp.stdin_binding {
        *binding.borrow_mut() = remainder.to_string();
    }
    let value = if flags.contains('r') {
        line.to_string()
    } else {
        unescape_read_line(line)
    };
    let fields: Vec<&str> = value
        .split([' ', '\t'])
        .filter(|field| !field.is_empty())
        .collect();
    for (index, name) in targets.iter().enumerate() {
        let value = if index + 1 == targets.len() {
            fields[index..].join(" ")
        } else {
            fields.get(index).copied().unwrap_or_default().to_string()
        };
        interp.env.insert((*name).to_string(), value);
    }
    if complete {
        ok(String::new())
    } else {
        fail(String::new(), 1)
    }
}

fn unescape_read_line(line: &str) -> String {
    let mut out = String::new();
    let mut chars = line.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// The shared "unknown option" diagnostic upstream's `unknownOption` helper
/// produces: GNU-style `unrecognized option` for long flags, `invalid
/// option` for short ones.
pub(crate) fn unknown_option(cmd: &str, opt: &str) -> CommandOutput {
    if let Some(long) = opt.strip_prefix("--") {
        let _ = long;
        fail(format!("{cmd}: unrecognized option '{opt}'\n"), 1)
    } else {
        let c = opt.trim_start_matches('-');
        fail(format!("{cmd}: invalid option -- '{c}'\n"), 1)
    }
}

/// Run one command. `args[0]` is the command name; `_scoped` holds any prefix
/// assignments for future external-process support (builtins ignore it).
pub fn dispatch(
    interp: &mut Interpreter,
    args: &[String],
    stdin: String,
    _scoped: Option<BTreeMap<String, String>>,
) -> CommandOutput {
    let name = args[0].as_str();
    let rest = &args[1..];
    match name {
        "echo" => builtin_echo(rest),
        "pwd" => ok(format!("{}\n", interp.cwd)),
        "true" | ":" => ok(String::new()),
        "false" => fail(String::new(), 1),
        "cd" => builtin_cd(interp, rest),
        "export" => builtin_export(interp, rest),
        "unset" => builtin_unset(interp, rest),
        "read" => builtin_read(interp, rest, stdin),
        "cat" => builtin_cat(interp, rest, stdin),
        "mkdir" => builtin_mkdir(interp, rest),
        "ls" => builtin_ls(interp, rest),
        "stat" => builtin_stat(interp, rest),
        "rm" => builtin_rm(interp, rest),
        "touch" => builtin_touch(interp, rest),
        "test" | "[" => builtin_test(interp, name, rest),
        "grep" => grep::grep(interp, rest, stdin, false),
        "egrep" => grep::grep(interp, rest, stdin, true),
        "fgrep" => grep::fgrep(interp, rest, stdin),
        "sed" => sed::sed(interp, rest, stdin),
        "wc" => text::wc(interp, rest, stdin),
        "sort" => sort_uniq::sort(interp, rest, stdin),
        "uniq" => sort_uniq::uniq(interp, rest, stdin),
        "head" => text::head(interp, rest, stdin),
        "tail" => text::tail(interp, rest, stdin),
        "cut" => text::cut(interp, rest, stdin),
        "tr" => text::tr(rest, stdin),
        "printf" => text::printf(interp, rest),
        "xargs" => xargs::xargs(interp, rest, stdin),
        "find" => find::find(interp, rest),
        "basename" => text::basename(rest),
        "dirname" => text::dirname(rest),
        "jq" => jq::jq(interp, rest, stdin),
        "awk" => awk::awk(interp, rest, stdin),
        "date" => timeutil::date(interp, rest),
        "expr" => timeutil::expr(rest),
        "sleep" => timeutil::sleep_cmd(interp, rest),
        "timeout" => timeutil::timeout(interp, rest, stdin),
        "time" => timeutil::time_cmd(interp, rest, stdin),
        "seq" => misc::seq(rest),
        "tee" => misc::tee(interp, rest, stdin),
        "which" => misc::which(interp, rest),
        "env" => misc::env(interp, rest, stdin),
        "printenv" => misc::printenv(interp, rest),
        "whoami" => misc::whoami(),
        "hostname" => misc::hostname(),
        "alias" => misc::alias(interp, rest),
        "unalias" => misc::unalias(interp, rest),
        "help" => misc::help(interp, rest),
        "clear" => misc::clear(),
        "base64" => hash::base64(interp, rest, stdin),
        "md5sum" => hash::md5sum(interp, rest, stdin),
        "sha256sum" => hash::sha256sum(interp, rest, stdin),
        "diff" => diff::diff(interp, rest, stdin),
        "cp" => fsutil::cp(interp, rest),
        "mv" => fsutil::mv(interp, rest),
        "rmdir" => fsutil::rmdir(interp, rest),
        "chmod" => fsutil::chmod(interp, rest),
        "readlink" => fsutil::readlink(interp, rest),
        "ln" => fsutil::ln(interp, rest),
        "file" => fsutil::file(interp, rest),
        "du" => fsutil::du(interp, rest),
        "tree" => fsutil::tree(interp, rest),
        "comm" => textutil2::comm(interp, rest, &stdin),
        "join" => textutil2::join(interp, rest, &stdin),
        "nl" => textutil2::nl(interp, rest, &stdin),
        "od" => textutil2::od(interp, rest, &stdin),
        "rev" => textutil2::rev(interp, rest, &stdin),
        "fold" => textutil2::fold(interp, rest, &stdin),
        "expand" => textutil2::expand(interp, rest, &stdin),
        "unexpand" => textutil2::unexpand(interp, rest, &stdin),
        "column" => textutil2::column(interp, rest, &stdin),
        "paste" => textutil2::paste(interp, rest, &stdin),
        "strings" => textutil2::strings(interp, rest, &stdin),
        "split" => textutil2::split(interp, rest, &stdin),
        "sh" | "bash" => builtin_sh(interp, name, rest),
        "source" | "." => builtin_source(interp, name, rest),
        "break" | "continue" => builtin_loop_control(interp, name, rest),
        "set" => builtin_set(interp, rest),
        "shift" => builtin_shift(interp, rest),
        // A path-like name (`./x.sh`, `/workspace/x.sh`) runs a VFS file;
        // everything else falls through to host-registered custom commands.
        _ if name.contains('/') => run_path_script(interp, name, rest),
        _ => run_custom_or_fail(interp, name, rest, stdin),
    }
}

/// `sh`/`bash`: run `-c "script"` or a script file in a subshell (isolated
/// env/cwd), regardless of the file's execute bit. Unmodelled options (`-e`,
/// `-x`, ...) are skipped rather than rejected.
fn builtin_sh(interp: &mut Interpreter, name: &str, args: &[String]) -> CommandOutput {
    let mut idx = 0;
    while idx < args.len() && args[idx].starts_with('-') && args[idx] != "-" {
        match args[idx].as_str() {
            "-c" => {
                return match args.get(idx + 1) {
                    // `sh -c SRC [name [args...]]`: the first trailing operand is
                    // `$0`, the rest are `$1..`.
                    Some(src) => {
                        let arg0 = args
                            .get(idx + 2)
                            .cloned()
                            .unwrap_or_else(|| name.to_string());
                        let params = args.get(idx + 3..).unwrap_or(&[]);
                        interp.run_script_isolated(src, &arg0, params)
                    }
                    None => fail(format!("{name}: -c: option requires an argument\n"), 2),
                };
            }
            "--" => {
                idx += 1;
                break;
            }
            _ => idx += 1,
        }
    }
    let Some(file) = args.get(idx) else {
        // With no script, real bash would open a REPL; here it's a no-op.
        return ok(String::new());
    };
    let path = normalize_path(&interp.cwd, file);
    match interp.fs.read_file(&path).as_deref() {
        Some(bytes) => {
            let src = String::from_utf8_lossy(bytes).into_owned();
            let params = args.get(idx + 1..).unwrap_or(&[]);
            interp.run_script_isolated(&src, file, params)
        }
        None => fail(format!("{name}: {file}: No such file or directory\n"), 127),
    }
}

/// `source file` / `. file`: run a script in the current shell (no isolation),
/// so its assignments and `cd` persist. The path is resolved against the cwd
/// (this port has no `PATH` search).
fn builtin_source(interp: &mut Interpreter, name: &str, args: &[String]) -> CommandOutput {
    let Some(file) = args.first() else {
        return fail(format!("{name}: filename argument required\n"), 2);
    };
    let path = normalize_path(&interp.cwd, file);
    match interp.fs.read_file(&path).as_deref() {
        Some(bytes) => {
            let src = String::from_utf8_lossy(bytes).into_owned();
            interp.run_source_with_args(&src, &args[1..])
        }
        None => fail(format!("{name}: {file}: No such file or directory\n"), 1),
    }
}

/// `break [N]` / `continue [N]`: unwind N enclosing loops via
/// `Interpreter::loop_control`, which the loop executors consume. A count past
/// the available depth clamps to it (bash behaviour); outside any loop bash
/// warns and exits 0.
fn builtin_loop_control(interp: &mut Interpreter, name: &str, args: &[String]) -> CommandOutput {
    if interp.loop_depth == 0 {
        return fail(
            format!("bash: {name}: only meaningful in a `for`, `while`, or `until` loop\n"),
            0,
        );
    }
    let depth = match args.first() {
        None => 1,
        Some(raw) => match raw.parse::<u32>() {
            Ok(0) => {
                return fail(format!("bash: {name}: 0: loop count out of range\n"), 1);
            }
            Ok(n) => n.min(interp.loop_depth),
            Err(_) => {
                return fail(
                    format!("bash: {name}: {raw}: numeric argument required\n"),
                    1,
                );
            }
        },
    };
    interp.loop_control = Some(if name == "break" {
        LoopControl::Break(depth)
    } else {
        LoopControl::Continue(depth)
    });
    ok(String::new())
}

/// `set [-/+][eux] [-o name] ... [-- args...]`: toggle the shell options this
/// port models (`errexit`, `nounset`, `xtrace`, `pipefail`; `-` on, `+` off)
/// and/or replace the positional parameters. Operands begin at `--` or the
/// first non-flag word, and (when present) become `$1..`; a bare `set -e` with
/// no operands leaves the parameters untouched. Unmodelled flags are accepted
/// silently so a script's leading `set -euo pipefail` never aborts.
fn builtin_set(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    let mut i = 0;
    let mut operands: Option<Vec<String>> = None;
    while i < args.len() {
        let arg = &args[i];
        if operands.is_none() {
            if arg == "--" {
                operands = Some(Vec::new());
                i += 1;
                continue;
            }
            let flags = arg
                .strip_prefix('-')
                .or_else(|| arg.strip_prefix('+'))
                .filter(|f| !f.is_empty());
            if let Some(flags) = flags {
                let on = arg.starts_with('-');
                let mut consumed_name = false;
                for ch in flags.chars() {
                    match ch {
                        'e' => interp.options.errexit = on,
                        'u' => interp.options.nounset = on,
                        'x' => interp.options.xtrace = on,
                        // `-o name` / the trailing `o` of `-euo pipefail`.
                        'o' => {
                            if let Some(name) = args.get(i + 1) {
                                apply_named_option(interp, name, on);
                                consumed_name = true;
                            }
                        }
                        _ => {}
                    }
                }
                i += 1 + usize::from(consumed_name);
                continue;
            }
            // A non-flag word: everything from here on is a positional operand.
            operands = Some(Vec::new());
        }
        operands.as_mut().unwrap().push(arg.clone());
        i += 1;
    }
    if let Some(params) = operands {
        interp.positional = params;
    }
    ok(String::new())
}

/// `shift [n]`: drop the first `n` positional parameters (default 1). Shifting
/// past the end changes nothing and returns non-zero, like bash.
fn builtin_shift(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    let n = match args.first() {
        None => 1,
        Some(s) => match s.parse::<usize>() {
            Ok(n) => n,
            Err(_) => return fail(format!("bash: shift: {s}: numeric argument required\n"), 1),
        },
    };
    if n > interp.positional.len() {
        return fail(String::new(), 1);
    }
    interp.positional.drain(..n);
    ok(String::new())
}

fn apply_named_option(interp: &mut Interpreter, name: &str, on: bool) {
    match name {
        "errexit" => interp.options.errexit = on,
        "nounset" => interp.options.nounset = on,
        "xtrace" => interp.options.xtrace = on,
        "pipefail" => interp.options.pipefail = on,
        _ => {}
    }
}

/// Run a file named directly by path (`./x.sh`, `/workspace/x.sh`). Mirrors
/// bash's diagnostics: a missing file is `command not found`-adjacent (127), a
/// directory or a non-executable file is 126.
fn run_path_script(interp: &mut Interpreter, name: &str, args: &[String]) -> CommandOutput {
    let path = normalize_path(&interp.cwd, name);
    if interp.fs.is_dir(&path) {
        return fail(format!("bash: {name}: Is a directory\n"), 126);
    }
    let Some(bytes) = interp.fs.read_file(&path) else {
        return fail(format!("bash: {name}: No such file or directory\n"), 127);
    };
    if !interp.fs.is_executable(&path) {
        return fail(format!("bash: {name}: Permission denied\n"), 126);
    }
    let src = String::from_utf8_lossy(&bytes).into_owned();
    interp.run_script_isolated(&src, name, args)
}

/// Host-registered commands (`custom_command.rs`) are checked only after the
/// fixed builtin table above has no match, so a custom command can never
/// shadow a builtin. The handler is temporarily removed from the registry so
/// it can be called with a `&mut Interpreter` that also owns the registry (a
/// self-borrow the type system otherwise rejects), then put back for the next
/// call - see `CustomCommands`'s doc comment.
fn run_custom_or_fail(
    interp: &mut Interpreter,
    name: &str,
    rest: &[String],
    stdin: String,
) -> CommandOutput {
    match interp.custom_commands.take(name) {
        Some(mut handler) => {
            let result = handler(interp, rest, stdin);
            interp.custom_commands.put_back(name.to_string(), handler);
            poll_script_watch(interp);
            result
        }
        None => fail(format!("bash: {name}: command not found\n"), 127),
    }
}

/// Durable boundary: peek the script-watch signal once a host-backed command
/// finished. When it fired, the remaining statements are skipped but this
/// command's output and status stand.
fn poll_script_watch(interp: &mut Interpreter) {
    let Some(watch) = &interp.watch else { return };
    if let Some(kind) = watch.borrow_mut().poll()
        && interp.interrupted.is_none()
    {
        interp.interrupted = Some(kind);
    }
}

fn builtin_echo(args: &[String]) -> CommandOutput {
    let mut newline = true;
    let mut start = 0;
    while start < args.len() && args[start] == "-n" {
        newline = false;
        start += 1;
    }
    let mut out = args[start..].join(" ");
    if newline {
        out.push('\n');
    }
    ok(out)
}

/// Split flags (`-x`) from operands. Returns `(flags_joined, operands)`. A lone
/// `--` ends flag parsing; a bare `-` is treated as an operand (stdin).
fn split_flags(args: &[String]) -> (String, Vec<&String>) {
    let mut flags = String::new();
    let mut operands = Vec::new();
    let mut only_operands = false;
    for arg in args {
        if !only_operands && arg == "--" {
            only_operands = true;
        } else if !only_operands && arg.len() > 1 && arg.starts_with('-') {
            flags.push_str(&arg[1..]);
        } else {
            operands.push(arg);
        }
    }
    (flags, operands)
}

fn builtin_cat(interp: &Interpreter, args: &[String], stdin: String) -> CommandOutput {
    // With no file operands, `cat` streams stdin. Otherwise it concatenates the
    // named files ("-" reads stdin), reporting missing ones like coreutils.
    if args.is_empty() {
        return ok(stdin);
    }
    let mut out = String::new();
    let mut stderr = String::new();
    let mut exit_code = 0;
    for arg in args {
        if arg == "-" {
            out.push_str(&stdin);
            continue;
        }
        let path = normalize_path(&interp.cwd, arg);
        if interp.fs.is_dir(&path) {
            stderr.push_str(&format!("cat: {arg}: Is a directory\n"));
            exit_code = 1;
        } else {
            match interp.fs.read_file_checked(&path) {
                Ok(bytes) => out.push_str(&String::from_utf8_lossy(&bytes)),
                Err(FileReadError::TooLarge { reference, .. }) => {
                    let digest = match &reference.origin {
                        LazyOrigin::Cas(digest) => digest.as_str().to_string(),
                        LazyOrigin::Foreign(key) => key.clone(),
                    };
                    out.push_str(&format!(
                        "<{}, {}, {}>\n",
                        mime_for_path(arg),
                        digest,
                        human_byte_size(reference.size)
                    ));
                    exit_code = 1;
                }
                Err(FileReadError::NotFound(_)) => {
                    stderr.push_str(&format!("cat: {arg}: No such file or directory\n"));
                    exit_code = 1;
                }
                Err(FileReadError::Unavailable(_)) => {
                    stderr.push_str(&format!("cat: {arg}: File body is unavailable\n"));
                    exit_code = 1;
                }
            }
        }
    }
    CommandOutput {
        stdout: out,
        stderr,
        exit_code,
    }
}

fn builtin_mkdir(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    let (flags, operands) = split_flags(args);
    let parents = flags.contains('p');
    if operands.is_empty() {
        return fail("mkdir: missing operand\n".to_string(), 1);
    }
    let mut stderr = String::new();
    let mut exit_code = 0;
    for operand in operands {
        let path = normalize_path(&interp.cwd, operand);
        match interp.fs.mkdir(&path, parents) {
            Ok(()) => {}
            Err(FsError::FileExists(_)) => {
                stderr.push_str(&format!(
                    "mkdir: cannot create directory '{operand}': File exists\n"
                ));
                exit_code = 1;
            }
            Err(FsError::NotFound(_)) => {
                stderr.push_str(&format!(
                    "mkdir: cannot create directory '{operand}': No such file or directory\n"
                ));
                exit_code = 1;
            }
            Err(FsError::IsDirectory(_) | FsError::ReadUnavailable(_)) => exit_code = 1,
        }
    }
    CommandOutput {
        stdout: String::new(),
        stderr,
        exit_code,
    }
}

fn builtin_ls(interp: &Interpreter, args: &[String]) -> CommandOutput {
    let (flags, operands) = split_flags(args);
    let long = flags.contains('l');
    let all = flags.contains('a');
    // Each target keeps its display name (for errors/headers) and resolved path.
    let targets: Vec<(String, String)> = if operands.is_empty() {
        vec![(interp.cwd.clone(), interp.cwd.clone())]
    } else {
        operands
            .iter()
            .map(|o| (o.to_string(), normalize_path(&interp.cwd, o)))
            .collect()
    };
    let multiple = targets.len() > 1;
    let mut blocks: Vec<String> = Vec::new();
    let mut stderr = String::new();
    let mut exit_code = 0;
    for (name, path) in &targets {
        if interp.fs.is_file(path) {
            blocks.push(ls_file_line(interp, name, path, long));
        } else if interp.fs.is_dir(path) {
            let mut block = String::new();
            if multiple {
                block.push_str(&format!("{path}:\n"));
            }
            block.push_str(&ls_dir(interp, path, long, all));
            blocks.push(block);
        } else {
            stderr.push_str(&format!(
                "ls: cannot access '{name}': No such file or directory\n"
            ));
            exit_code = 1;
        }
    }
    // Multiple listings are separated by a blank line (each block ends in \n).
    let out = blocks.join(if multiple { "\n" } else { "" });
    CommandOutput {
        stdout: out,
        stderr,
        exit_code,
    }
}

/// A file's byte length; directories report 0 (as the JS reference does, this
/// VFS having no real block accounting to improve on).
fn ls_size(interp: &Interpreter, path: &str) -> u64 {
    interp.fs.file_size(path).unwrap_or(0)
}

/// One `ls -l` line. The VFS tracks no owner/mtime, so the reference's fixed
/// `1 user user` / `Jan  1 00:00` and `drwxr-xr-x`/`-rw-r--r--` modes are used.
fn ls_long_line(mode: &str, size: u64, name: &str) -> String {
    format!("{mode} 1 user user {size:>5} Jan  1 00:00 {name}\n")
}

fn ls_file_line(interp: &Interpreter, display: &str, path: &str, long: bool) -> String {
    if long {
        ls_long_line("-rw-r--r--", ls_size(interp, path), display)
    } else {
        format!("{display}\n")
    }
}

fn ls_dir(interp: &Interpreter, path: &str, long: bool, all: bool) -> String {
    let mut names: Vec<String> = interp.fs.readdir(path).unwrap_or_default();
    if all {
        names.push(".".to_string());
        names.push("..".to_string());
    } else {
        names.retain(|n| !n.starts_with('.'));
    }
    names.sort_by(|a, b| locale_compare(a, b));

    if !long {
        return names.iter().map(|n| format!("{n}\n")).collect();
    }
    let mut out = format!("total {}\n", names.len());
    for name in &names {
        if name == "." || name == ".." {
            out.push_str(&ls_long_line("drwxr-xr-x", 0, name));
            continue;
        }
        let child = normalize_path(path, name);
        if interp.fs.is_dir(&child) {
            out.push_str(&ls_long_line("drwxr-xr-x", 0, name));
        } else {
            out.push_str(&ls_long_line("-rw-r--r--", ls_size(interp, &child), name));
        }
    }
    out
}

fn builtin_stat(interp: &Interpreter, args: &[String]) -> CommandOutput {
    let mut format: Option<&str> = None;
    let mut files: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-c" | "--format" => {
                let Some(value) = args.get(i + 1) else {
                    return fail("stat: option requires an argument\n".to_string(), 1);
                };
                format = Some(value);
                i += 2;
            }
            arg if arg.starts_with("--format=") => {
                format = Some(&arg["--format=".len()..]);
                i += 1;
            }
            "-L" | "--dereference" => i += 1,
            arg if arg.starts_with('-') => return unknown_option("stat", arg),
            file => {
                files.push(file);
                i += 1;
            }
        }
    }
    if files.is_empty() {
        return fail("stat: missing operand\n".to_string(), 1);
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    for file in files {
        let path = normalize_path(&interp.cwd, file);
        if !interp.fs.exists(&path) {
            stderr.push_str(&format!(
                "stat: cannot statx '{file}': No such file or directory\n"
            ));
            continue;
        }
        let is_dir = interp.fs.is_dir(&path);
        let size = if is_dir {
            0
        } else {
            interp.fs.file_size(&path).unwrap_or(0)
        };
        let kind = if is_dir { "directory" } else { "regular file" };
        if let Some(format) = format {
            stdout.push_str(&stat_format(format, file, size, kind));
            stdout.push('\n');
        } else {
            stdout.push_str(&format!(
                "  File: {file}\n  Size: {size}\tBlocks: {}\tIO Block: 4096   {kind}\n",
                size.div_ceil(512)
            ));
        }
    }
    let exit_code = if stderr.is_empty() { 0 } else { 1 };
    CommandOutput {
        stdout,
        stderr,
        exit_code,
    }
}

fn stat_format(template: &str, name: &str, size: u64, kind: &str) -> String {
    let mut out = String::new();
    let mut chars = template.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('%') => out.push('%'),
            Some('n') => out.push_str(name),
            Some('s') => out.push_str(&size.to_string()),
            Some('F') => out.push_str(kind),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

fn human_byte_size(size: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    if size < 1024 {
        format!("{size} B")
    } else if size < 1024 * 1024 {
        format!("{:.1} KB", size as f64 / KIB)
    } else if size < 1024 * 1024 * 1024 {
        format!("{:.1} MB", size as f64 / MIB)
    } else {
        format!("{:.1} GB", size as f64 / GIB)
    }
}

fn mime_for_path(path: &str) -> &'static str {
    let extension = path.rsplit_once('.').map(|(_, extension)| extension);
    match extension.map(str::to_ascii_lowercase).as_deref() {
        Some("wasm") => "application/wasm",
        Some("json") => "application/json",
        Some("js" | "mjs" | "cjs") => "text/javascript",
        Some("ts") => "text/typescript",
        Some("html" | "htm") => "text/html",
        Some("css") => "text/css",
        Some("md" | "markdown") => "text/markdown",
        Some("txt") => "text/plain",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("pdf") => "application/pdf",
        Some("zip") => "application/zip",
        Some("gz") => "application/gzip",
        _ => "application/octet-stream",
    }
}

fn builtin_rm(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    let (flags, operands) = split_flags(args);
    let recursive = flags.contains('r') || flags.contains('R');
    let force = flags.contains('f');
    if operands.is_empty() && !force {
        return fail("rm: missing operand\n".to_string(), 1);
    }
    let mut stderr = String::new();
    let mut exit_code = 0;
    for operand in operands {
        let path = normalize_path(&interp.cwd, operand);
        match interp.fs.remove(&path, recursive) {
            Ok(()) => {}
            Err(FsError::NotFound(_)) => {
                if !force {
                    stderr.push_str(&format!(
                        "rm: cannot remove '{operand}': No such file or directory\n"
                    ));
                    exit_code = 1;
                }
            }
            Err(FsError::IsDirectory(_)) => {
                stderr.push_str(&format!("rm: cannot remove '{operand}': Is a directory\n"));
                exit_code = 1;
            }
            Err(FsError::FileExists(_) | FsError::ReadUnavailable(_)) => exit_code = 1,
        }
    }
    CommandOutput {
        stdout: String::new(),
        stderr,
        exit_code,
    }
}

fn builtin_touch(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    let (_flags, operands) = split_flags(args);
    if operands.is_empty() {
        return fail("touch: missing file operand\n".to_string(), 1);
    }
    let mut stderr = String::new();
    let mut exit_code = 0;
    for operand in operands {
        let path = normalize_path(&interp.cwd, operand);
        if interp.fs.exists(&path) {
            continue; // Only mtime would change; nothing to do here.
        }
        if let Err(FsError::IsDirectory(_)) = interp.fs.write_file(&path, b"") {
            stderr.push_str(&format!(
                "touch: cannot touch '{operand}': Is a directory\n"
            ));
            exit_code = 1;
        }
    }
    CommandOutput {
        stdout: String::new(),
        stderr,
        exit_code,
    }
}

/// `test` / `[ ... ]`: evaluate a conditional expression. Exit 0 = true, 1 =
/// false, 2 = usage error. Supports the string, integer, and file-test operators
/// the agent shell's `if`/`while` conditions actually use.
fn builtin_test(interp: &Interpreter, name: &str, args: &[String]) -> CommandOutput {
    let mut args: Vec<&String> = args.iter().collect();
    if name == "[" {
        match args.last() {
            Some(last) if last.as_str() == "]" => {
                args.pop();
            }
            _ => return fail("bash: [: missing `]'\n".to_string(), 2),
        }
    }
    match eval_test(interp, &args) {
        Ok(true) => ok(String::new()),
        Ok(false) => fail(String::new(), 1),
        Err(message) => fail(message, 2),
    }
}

fn eval_test(interp: &Interpreter, args: &[&String]) -> Result<bool, String> {
    // A leading `!` negates the rest of the expression.
    if let [first, rest @ ..] = args
        && first.as_str() == "!"
    {
        return Ok(!eval_test(interp, rest)?);
    }
    match args {
        [] => Ok(false),
        [value] => Ok(!value.is_empty()),
        [op, operand] => {
            let path = || normalize_path(&interp.cwd, operand);
            match op.as_str() {
                "-z" => Ok(operand.is_empty()),
                "-n" => Ok(!operand.is_empty()),
                "-e" => Ok(interp.fs.exists(&path())),
                "-f" => Ok(interp.fs.is_file(&path())),
                "-d" => Ok(interp.fs.is_dir(&path())),
                _ => Err(format!("bash: test: {op}: unary operator expected\n")),
            }
        }
        [a, op, b] => match op.as_str() {
            "=" | "==" => Ok(a == b),
            "!=" => Ok(a != b),
            "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge" => {
                let x = parse_int(a)?;
                let y = parse_int(b)?;
                Ok(match op.as_str() {
                    "-eq" => x == y,
                    "-ne" => x != y,
                    "-lt" => x < y,
                    "-le" => x <= y,
                    "-gt" => x > y,
                    "-ge" => x >= y,
                    _ => unreachable!(),
                })
            }
            _ => Err(format!("bash: test: {op}: binary operator expected\n")),
        },
        _ => Err("bash: test: too many arguments\n".to_string()),
    }
}

fn parse_int(text: &str) -> Result<i64, String> {
    text.trim()
        .parse::<i64>()
        .map_err(|_| format!("bash: test: {text}: integer expression expected\n"))
}

/// Approximates JS `String.prototype.localeCompare` for filename sorting, which
/// `ls`/`tree` upstream use: compare case-insensitively first (so `a`, `A`, `b`
/// sort in that order rather than raw-ASCII `A`, `a`, `b`), then break ties with
/// lowercase before uppercase. Full ICU collation of punctuation/digits is out
/// of scope; the base compare falls back to codepoint order.
pub(crate) fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (al, bl) = (a.to_lowercase(), b.to_lowercase());
    match al.cmp(&bl) {
        Ordering::Equal => {
            for (ca, cb) in a.chars().zip(b.chars()) {
                if ca != cb {
                    // Same base letter, differing case: lowercase sorts first.
                    return match (ca.is_lowercase(), cb.is_lowercase()) {
                        (true, false) => Ordering::Less,
                        (false, true) => Ordering::Greater,
                        _ => ca.cmp(&cb),
                    };
                }
            }
            a.len().cmp(&b.len())
        }
        other => other,
    }
}

fn builtin_cd(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    let target = match args.first() {
        Some(dir) if !dir.is_empty() => dir.clone(),
        _ => interp
            .env
            .get("HOME")
            .cloned()
            .unwrap_or_else(|| "/".to_string()),
    };
    // Validate each path component (before `..` collapse) against the VFS, so
    // `missing/..` fails even though it normalizes back to an existing dir.
    // Mirrors the JS reference's component-wise stat walk.
    let to_check = if target.starts_with('/') {
        target.clone()
    } else {
        format!("{}/{}", interp.cwd, target)
    };
    let mut current = String::new();
    for part in to_check.split('/').filter(|p| !p.is_empty() && *p != ".") {
        if part == ".." {
            current = current
                .rsplit_once('/')
                .map(|(head, _)| head.to_string())
                .unwrap_or_default();
            continue;
        }
        current = format!("{current}/{part}");
        if interp.fs.is_dir(&current) {
            continue;
        }
        let reason = if interp.fs.exists(&current) {
            "Not a directory"
        } else {
            "No such file or directory"
        };
        return fail(format!("bash: cd: {target}: {reason}\n"), 1);
    }
    let next = normalize_path(&interp.cwd, &target);
    interp.cwd = next.clone();
    interp.env.insert("PWD".to_string(), next);
    ok(String::new())
}

fn builtin_export(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    for arg in args {
        if let Some(eq) = arg.find('=') {
            let (name, value) = (&arg[..eq], &arg[eq + 1..]);
            interp.env.insert(name.to_string(), value.to_string());
        }
        // `export NAME` with no value is a no-op here (no unexported vars yet).
    }
    ok(String::new())
}

fn builtin_unset(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    for name in args {
        interp.env.remove(name);
    }
    ok(String::new())
}

/// Resolve `target` against `cwd`, collapsing `.` and `..`. Purely lexical: no
/// filesystem is consulted.
pub(crate) fn normalize_path(cwd: &str, target: &str) -> String {
    let base = if target.starts_with('/') {
        String::from("/")
    } else {
        format!("{cwd}/")
    };
    let combined = format!("{base}{target}");
    let mut stack: Vec<&str> = Vec::new();
    for segment in combined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    format!("/{}", stack.join("/"))
}

/// Read stdin or concatenate named files (`-` means stdin), coreutils-style,
/// for commands that treat the whole input as one blob (`cut`, `sort`,
/// `uniq`). Returns the shared "No such file or directory" / "Is a
/// directory" diagnostic on the first bad operand, matching `cat`'s wording.
pub(crate) fn read_concat(
    interp: &Interpreter,
    files: &[String],
    cmd: &str,
    stdin: &str,
) -> Result<String, CommandOutput> {
    if files.is_empty() {
        return Ok(stdin.to_string());
    }
    let mut out = String::new();
    for file in files {
        if file == "-" {
            out.push_str(stdin);
            continue;
        }
        let path = normalize_path(&interp.cwd, file);
        if interp.fs.is_dir(&path) {
            return Err(fail(format!("{cmd}: {file}: Is a directory\n"), 1));
        }
        match interp.fs.read_file(&path).as_deref() {
            Some(bytes) => out.push_str(&String::from_utf8_lossy(bytes)),
            None => {
                return Err(fail(
                    format!("{cmd}: {file}: No such file or directory\n"),
                    1,
                ));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_dot_dot() {
        assert_eq!(normalize_path("/workspace", "sub"), "/workspace/sub");
        assert_eq!(normalize_path("/workspace/a", ".."), "/workspace");
        assert_eq!(normalize_path("/workspace", "/tmp/./x"), "/tmp/x");
        assert_eq!(normalize_path("/a/b", "../../c"), "/c");
    }
}
