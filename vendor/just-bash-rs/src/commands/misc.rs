//! PORT (partial): vendor/just-bash/src/commands/{seq,tee,which,env,whoami,
//! hostname,alias,help,clear}/*.ts
//!
//! A grab-bag of small, mostly independent commands grouped in one file
//! (design doc's convention for commands too small to warrant their own
//! module). Execution-limit enforcement (`ExecutionLimitError` et al in
//! upstream) is not ported anywhere in this port, so it is dropped here too.

use std::collections::BTreeMap;

use super::{fail, normalize_path, ok, unknown_option};
use crate::interpreter::{CommandOutput, Interpreter};

// ---------------------------------------------------------------------
// seq
// ---------------------------------------------------------------------

pub fn seq(args: &[String]) -> CommandOutput {
    let mut separator = "\n".to_string();
    let mut equalize_width = false;
    let mut nums: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-s" && i + 1 < args.len() {
            separator = args[i + 1].clone();
            i += 2;
            continue;
        }
        if arg == "-w" {
            equalize_width = true;
            i += 1;
            continue;
        }
        if arg == "--" {
            i += 1;
            break;
        }
        if arg.starts_with('-') && arg != "-" {
            if let Some(rest) = arg.strip_prefix("-s")
                && !rest.is_empty()
            {
                separator = rest.to_string();
                i += 1;
                continue;
            }
            if (arg == "-ws" || arg == "-sw") && i + 1 < args.len() {
                equalize_width = true;
                separator = args[i + 1].clone();
                i += 2;
                continue;
            }
            // Unknown option: fall through, treat as a (possibly negative) number.
        }
        nums.push(arg.clone());
        i += 1;
    }
    while i < args.len() {
        nums.push(args[i].clone());
        i += 1;
    }

    if nums.is_empty() {
        return fail("seq: missing operand\n".to_string(), 1);
    }

    let (first, increment, last_str) = match nums.len() {
        1 => (1.0, 1.0, nums[0].as_str()),
        2 => {
            let first = match nums[0].parse::<f64>() {
                Ok(v) => v,
                Err(_) => return invalid_seq_arg(&nums[0]),
            };
            (first, 1.0, nums[1].as_str())
        }
        _ => {
            let first = match nums[0].parse::<f64>() {
                Ok(v) => v,
                Err(_) => return invalid_seq_arg(&nums[0]),
            };
            let increment = match nums[1].parse::<f64>() {
                Ok(v) => v,
                Err(_) => return invalid_seq_arg(&nums[1]),
            };
            (first, increment, nums[2].as_str())
        }
    };
    let last = match last_str.parse::<f64>() {
        Ok(v) if v.is_finite() => v,
        _ => return invalid_seq_arg(last_str),
    };
    if !first.is_finite() || !increment.is_finite() {
        let bad = if !first.is_finite() {
            &nums[0]
        } else {
            &nums[1]
        };
        return invalid_seq_arg(bad);
    }
    if increment == 0.0 {
        return fail("seq: invalid Zero increment value: '0'\n".to_string(), 1);
    }

    fn precision(n: f64) -> usize {
        let s = n.to_string();
        match s.find('.') {
            Some(idx) => s.len() - idx - 1,
            None => 0,
        }
    }
    let precision = precision(first)
        .max(precision(increment))
        .max(precision(last));

    let mut results: Vec<String> = Vec::new();
    if increment > 0.0 {
        let mut n = first;
        while n <= last + 1e-10 {
            results.push(format_seq_num(n, precision));
            n += increment;
        }
    } else {
        let mut n = first;
        while n >= last - 1e-10 {
            results.push(format_seq_num(n, precision));
            n += increment;
        }
    }

    if equalize_width && !results.is_empty() {
        let max_len = results
            .iter()
            .map(|r| {
                if let Some(s) = r.strip_prefix('-') {
                    s.len()
                } else {
                    r.len()
                }
            })
            .max()
            .unwrap_or(0);
        for r in &mut results {
            if let Some(rest) = r.strip_prefix('-') {
                *r = format!("-{:0>width$}", rest, width = max_len);
            } else {
                *r = format!("{:0>width$}", r, width = max_len);
            }
        }
    }

    let output = results.join(&separator);
    ok(if output.is_empty() {
        output
    } else {
        format!("{output}\n")
    })
}

fn invalid_seq_arg(bad: &str) -> CommandOutput {
    fail(
        format!("seq: invalid floating point argument: '{bad}'\n"),
        1,
    )
}

fn format_seq_num(n: f64, precision: usize) -> String {
    if precision > 0 {
        format!("{n:.precision$}")
    } else {
        format!("{}", n.round() as i64)
    }
}

// ---------------------------------------------------------------------
// tee
// ---------------------------------------------------------------------

pub fn tee(interp: &mut Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let (flags, operands) = super::split_flags(args);
    let append = flags.contains('a');
    let mut stderr = String::new();
    let mut exit_code = 0;
    for file in &operands {
        let path = normalize_path(&interp.cwd, file);
        let result = if append {
            interp.fs.append_file(&path, stdin.as_bytes())
        } else {
            interp.fs.write_file(&path, stdin.as_bytes())
        };
        if result.is_err() {
            stderr.push_str(&format!("tee: {file}: No such file or directory\n"));
            exit_code = 1;
        }
    }
    CommandOutput {
        stdout: stdin,
        stderr,
        exit_code,
    }
}

// ---------------------------------------------------------------------
// which
// ---------------------------------------------------------------------

/// Upstream seeds a stub file at `/bin/<name>` and `/usr/bin/<name>` for
/// every registered command so `which`/PATH-resolution has something to
/// find. This port doesn't seed the virtual filesystem (no new Vfs
/// features as a side effect of this task); instead `which` treats a
/// command as "found" in `/usr/bin` or `/bin` directly whenever it's a
/// registered builtin, which reproduces the same observable behavior for
/// every case this shell's command set can exercise.
pub fn which(interp: &Interpreter, args: &[String]) -> CommandOutput {
    let mut show_all = false;
    let mut silent = false;
    let mut names: Vec<&String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-a" => show_all = true,
            "-s" => silent = true,
            "-as" | "-sa" => {
                show_all = true;
                silent = true;
            }
            _ => names.push(arg),
        }
    }
    if names.is_empty() {
        return fail(String::new(), 1);
    }

    let path_env = interp
        .env
        .get("PATH")
        .cloned()
        .unwrap_or_else(|| "/usr/bin:/bin".to_string());
    let dirs: Vec<&str> = path_env.split(':').collect();
    let registered = super::command_names();

    let mut stdout = String::new();
    let mut all_found = true;
    for name in names {
        let mut found = false;
        for dir in &dirs {
            if dir.is_empty() {
                continue;
            }
            if (*dir == "/usr/bin" || *dir == "/bin") && registered.contains(&name.as_str()) {
                found = true;
                if !silent {
                    stdout.push_str(&format!("{dir}/{name}\n"));
                }
                if !show_all {
                    break;
                }
            }
        }
        if !found {
            all_found = false;
        }
    }
    CommandOutput {
        stdout,
        stderr: String::new(),
        exit_code: if all_found { 0 } else { 1 },
    }
}

// ---------------------------------------------------------------------
// env / printenv
// ---------------------------------------------------------------------

pub fn env(interp: &mut Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut ignore_env = false;
    let mut unset_vars: Vec<String> = Vec::new();
    let mut set_vars: Vec<(String, String)> = Vec::new();
    let mut command_start: Option<usize> = None;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-i" || arg == "--ignore-environment" {
            ignore_env = true;
        } else if arg == "-u" && i + 1 < args.len() {
            i += 1;
            unset_vars.push(args[i].clone());
        } else if let Some(rest) = arg.strip_prefix("-u") {
            if !rest.is_empty() {
                unset_vars.push(rest.to_string());
            }
        } else if let Some(rest) = arg.strip_prefix("--unset=") {
            unset_vars.push(rest.to_string());
        } else if arg.starts_with("--") && arg != "--" {
            return unknown_option("env", arg);
        } else if arg.starts_with('-') && arg != "-" {
            for c in arg[1..].chars() {
                if c != 'i' && c != 'u' {
                    return unknown_option("env", &format!("-{c}"));
                }
            }
            if arg.contains('i') {
                ignore_env = true;
            }
        } else if arg.contains('=') && command_start.is_none() {
            let eq = arg.find('=').unwrap();
            set_vars.push((arg[..eq].to_string(), arg[eq + 1..].to_string()));
        } else {
            command_start = Some(i);
            break;
        }
        i += 1;
    }

    let mut new_env: BTreeMap<String, String> = if ignore_env {
        BTreeMap::new()
    } else {
        interp.env.clone()
    };
    if !ignore_env {
        for name in &unset_vars {
            new_env.remove(name);
        }
    }
    for (name, value) in &set_vars {
        new_env.insert(name.clone(), value.clone());
    }

    let Some(start) = command_start else {
        let mut lines: Vec<String> = new_env.iter().map(|(k, v)| format!("{k}={v}")).collect();
        lines.sort();
        return ok(if lines.is_empty() {
            String::new()
        } else {
            format!("{}\n", lines.join("\n"))
        });
    };

    let cmd_args = &args[start..];
    let saved_env = std::mem::replace(&mut interp.env, new_env);
    let result = super::dispatch(interp, cmd_args, stdin, None);
    interp.env = saved_env;
    result
}

pub fn printenv(interp: &Interpreter, args: &[String]) -> CommandOutput {
    let vars: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    if vars.is_empty() {
        let mut lines: Vec<String> = interp.env.iter().map(|(k, v)| format!("{k}={v}")).collect();
        lines.sort();
        return ok(if lines.is_empty() {
            String::new()
        } else {
            format!("{}\n", lines.join("\n"))
        });
    }
    let mut lines = Vec::new();
    let mut exit_code = 0;
    for name in vars {
        match interp.env.get(name) {
            Some(v) => lines.push(v.clone()),
            None => exit_code = 1,
        }
    }
    CommandOutput {
        stdout: if lines.is_empty() {
            String::new()
        } else {
            format!("{}\n", lines.join("\n"))
        },
        stderr: String::new(),
        exit_code,
    }
}

// ---------------------------------------------------------------------
// whoami / hostname
// ---------------------------------------------------------------------

/// Sandboxed shell stand-in, matching upstream's own hardcoded `"user"`.
pub fn whoami() -> CommandOutput {
    ok("user\n".to_string())
}

/// Sandboxed shell stand-in, matching upstream's own hardcoded `"localhost"`.
pub fn hostname() -> CommandOutput {
    ok("localhost\n".to_string())
}

// ---------------------------------------------------------------------
// alias / unalias
// ---------------------------------------------------------------------
//
// Aliases are stored as `BASH_ALIAS_<name>` entries directly in the shell
// environment map, matching upstream's storage trick. Alias *expansion*
// (rewriting a command name to its alias value before dispatch) is not
// wired into the parser/dispatch loop anywhere in this port -- matching
// real non-interactive bash, which does not expand aliases in scripts
// either, so this is a deliberate no-gap: only `alias`'s own read/write/
// list behavior is implemented.

const ALIAS_PREFIX: &str = "BASH_ALIAS_";

pub fn alias(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    if args.is_empty() {
        let mut stdout = String::new();
        for (key, value) in &interp.env {
            if let Some(name) = key.strip_prefix(ALIAS_PREFIX) {
                stdout.push_str(&format!("alias {name}='{value}'\n"));
            }
        }
        return ok(stdout);
    }

    let process_args = if args[0] == "--" { &args[1..] } else { args };
    for arg in process_args {
        match arg.find('=') {
            None => {
                let key = format!("{ALIAS_PREFIX}{arg}");
                return match interp.env.get(&key) {
                    Some(value) => ok(format!("alias {arg}='{value}'\n")),
                    None => fail(format!("alias: {arg}: not found\n"), 1),
                };
            }
            Some(eq) => {
                let name = &arg[..eq];
                let mut value = &arg[eq + 1..];
                if (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
                    || (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
                {
                    value = &value[1..value.len() - 1];
                }
                interp
                    .env
                    .insert(format!("{ALIAS_PREFIX}{name}"), value.to_string());
            }
        }
    }
    ok(String::new())
}

pub fn unalias(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    if args.is_empty() {
        return fail(
            "unalias: usage: unalias [-a] name [name ...]\n".to_string(),
            1,
        );
    }
    if args[0] == "-a" {
        let keys: Vec<String> = interp
            .env
            .keys()
            .filter(|k| k.starts_with(ALIAS_PREFIX))
            .cloned()
            .collect();
        for key in keys {
            interp.env.remove(&key);
        }
        return ok(String::new());
    }
    let process_args = if args[0] == "--" { &args[1..] } else { args };
    let mut stderr = String::new();
    let mut any_error = false;
    for name in process_args {
        let key = format!("{ALIAS_PREFIX}{name}");
        if interp.env.remove(&key).is_none() {
            stderr.push_str(&format!("unalias: {name}: not found\n"));
            any_error = true;
        }
    }
    CommandOutput {
        stdout: String::new(),
        stderr,
        exit_code: if any_error { 1 } else { 0 },
    }
}

// ---------------------------------------------------------------------
// help
// ---------------------------------------------------------------------
//
// Upstream's `help` builtin carries a ~700-line database of real bash
// builtin man-page text (`interpreter/builtins/help.ts`); porting that
// verbatim is out of scope (same "partial subset" call as jq/awk). This
// implementation lists the registered command names instead of a
// hand-copied bash builtin manual, which is what an agent shell actually
// needs `help` for.

pub fn help(args: &[String]) -> CommandOutput {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        return ok("help - display available commands\n\nUsage: help [command]\n".to_string());
    }
    let names = super::command_names();
    if let Some(pattern) = args.iter().find(|a| !a.starts_with('-')) {
        return if names.contains(&pattern.as_str()) {
            ok(format!("{pattern}: a shell builtin\n"))
        } else {
            fail(
                format!("bash: help: no help topics match `{pattern}'.\n"),
                1,
            )
        };
    }
    let mut sorted = names;
    sorted.sort_unstable();
    ok(format!("just-bash shell builtins\n{}\n", sorted.join(" ")))
}

// ---------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------

pub fn clear() -> CommandOutput {
    ok("\x1B[2J\x1B[H".to_string())
}

#[cfg(test)]
mod tests {
    use crate::bash::Bash;
    use crate::types::{BashOptions, ExecOptions, ExecResult};

    fn fresh() -> Bash {
        Bash::new(BashOptions::default())
    }

    fn run(bash: &mut Bash, script: &str) -> ExecResult {
        bash.exec(script, ExecOptions::default())
    }

    #[test]
    fn seq_basic_and_step() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "seq 5").stdout, "1\n2\n3\n4\n5\n");
        assert_eq!(run(&mut bash, "seq 3 7").stdout, "3\n4\n5\n6\n7\n");
        assert_eq!(run(&mut bash, "seq 1 2 10").stdout, "1\n3\n5\n7\n9\n");
        assert_eq!(run(&mut bash, "seq 5 1").stdout, "");
    }

    #[test]
    fn seq_negative_and_float() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "seq 5 -1 1").stdout, "5\n4\n3\n2\n1\n");
        assert_eq!(
            run(&mut bash, "seq 1 0.5 3").stdout,
            "1.0\n1.5\n2.0\n2.5\n3.0\n"
        );
    }

    #[test]
    fn seq_separator_and_width() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "seq -s ',' 3").stdout, "1,2,3\n");
        assert_eq!(run(&mut bash, "seq -w 8 12").stdout, "08\n09\n10\n11\n12\n");
    }

    #[test]
    fn seq_errors() {
        let mut bash = fresh();
        let r = run(&mut bash, "seq");
        assert!(r.stderr.contains("missing operand"));
        assert_eq!(r.exit_code, 1);
        let r = run(&mut bash, "seq 1 0 5");
        assert!(r.stderr.contains("Zero increment"));
    }

    #[test]
    fn tee_passes_through_and_writes_file() {
        let mut bash = fresh();
        let r = run(&mut bash, "echo hello | tee /output.txt");
        assert_eq!(r.stdout, "hello\n");
        assert_eq!(
            bash.fs().read_file("/output.txt").as_deref(),
            Some(&b"hello\n"[..])
        );
    }

    #[test]
    fn tee_append_flag() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"existing\n")
            .unwrap();
        run(&mut bash, "echo appended | tee -a /test.txt");
        assert_eq!(
            bash.fs().read_file("/test.txt").as_deref(),
            Some(&b"existing\nappended\n"[..])
        );
    }

    #[test]
    fn which_finds_registered_command() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "which ls").stdout, "/usr/bin/ls\n");
        let r = run(&mut bash, "which nonexistent");
        assert_eq!(r.stdout, "");
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn which_dash_a_shows_both_dirs() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, "which -a ls").stdout,
            "/usr/bin/ls\n/bin/ls\n"
        );
    }

    #[test]
    fn which_respects_path() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, "export PATH=/bin; which ls").stdout,
            "/bin/ls\n"
        );
    }

    #[test]
    fn env_prints_variables() {
        let mut bash = fresh();
        let r = run(&mut bash, "export FOO=bar; env");
        assert!(r.stdout.contains("FOO=bar"));
    }

    #[test]
    fn env_runs_command_with_modified_environment() {
        let mut bash = fresh();
        let r = run(&mut bash, "env -i ONLY=value printenv ONLY");
        assert_eq!(r.stdout, "value\n");
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn printenv_specific_variables() {
        let mut bash = fresh();
        let r = run(&mut bash, "export FOO=bar BAZ=qux; printenv FOO BAZ");
        assert_eq!(r.stdout, "bar\nqux\n");
    }

    #[test]
    fn whoami_and_hostname() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "whoami").stdout, "user\n");
        assert_eq!(run(&mut bash, "hostname").stdout, "localhost\n");
    }

    #[test]
    fn alias_set_list_and_show() {
        let mut bash = fresh();
        let r = run(&mut bash, "alias ll='ls -la'; alias");
        assert_eq!(r.stdout, "alias ll='ls -la'\n");
        let r = run(&mut bash, "alias ll='ls -la'; alias ll");
        assert_eq!(r.stdout, "alias ll='ls -la'\n");
    }

    #[test]
    fn alias_not_found_errors() {
        let mut bash = fresh();
        let r = run(&mut bash, "alias notexists");
        assert!(r.stderr.contains("not found"));
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn unalias_removes_alias() {
        let mut bash = fresh();
        let r = run(&mut bash, "alias ll='ls -la'; unalias ll; alias ll");
        assert!(r.stderr.contains("not found"));
    }

    #[test]
    fn unalias_dash_a_removes_all() {
        let mut bash = fresh();
        let r = run(&mut bash, "alias ll='ls -la' la='ls -a'; unalias -a; alias");
        assert_eq!(r.stdout, "");
    }

    #[test]
    fn clear_emits_ansi_sequence() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "clear").stdout, "\x1B[2J\x1B[H");
    }

    #[test]
    fn help_lists_commands() {
        let mut bash = fresh();
        let r = run(&mut bash, "help");
        assert!(r.stdout.contains("echo"));
        let r = run(&mut bash, "help nonexistent");
        assert_eq!(r.exit_code, 1);
    }
}
