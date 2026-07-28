//! PORT: vendor/just-bash/src/commands/xargs/xargs.ts
//!
//! `xargs [-I REPLACE] [-d DELIM] [-n NUM] [-0] [-t] [-r] [COMMAND [ARGS...]]`.
//! Builds argv from stdin (whitespace-, null-, or custom-delimiter-separated)
//! and dispatches straight to `commands::dispatch` (the same registry a
//! pipeline command would hit) rather than round-tripping through the parser
//! — upstream's `ctx.exec` reruns the whole shell, but that generality isn't
//! needed here since xargs's command name is always a plain argv[0]. `-P`
//! (parallelism) is accepted and ignored (this interpreter is single
//! threaded and synchronous); `-t`/`-r` are supported.

use super::{fail, ok};
use crate::interpreter::{CommandOutput, Interpreter};

fn split_exact(input: &str, delimiter: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut start = 0;
    while start <= input.len() {
        match input[start..].find(delimiter) {
            Some(off) => {
                let item = &input[start..start + off];
                if !item.is_empty() {
                    items.push(item.to_string());
                }
                start += off + delimiter.len();
            }
            None => {
                let item = &input[start..];
                if !item.is_empty() {
                    items.push(item.to_string());
                }
                break;
            }
        }
    }
    items
}

fn split_whitespace_items(input: &str) -> Vec<String> {
    input.split_whitespace().map(|s| s.to_string()).collect()
}

pub fn xargs(interp: &mut Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut replace_str: Option<String> = None;
    let mut delimiter: Option<String> = None;
    let mut max_args: Option<usize> = None;
    let mut null_separator = false;
    let mut verbose = false;
    let mut no_run_if_empty = false;
    let mut command_start = 0;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-I" && i + 1 < args.len() {
            i += 1;
            replace_str = Some(args[i].clone());
            command_start = i + 1;
        } else if arg == "-d" && i + 1 < args.len() {
            i += 1;
            // Matches upstream's sequential (non-regex-aware) escape
            // replacement, applied in the same order.
            let d = args[i]
                .replace("\\n", "\n")
                .replace("\\t", "\t")
                .replace("\\r", "\r")
                .replace("\\0", "\0")
                .replace("\\\\", "\\");
            delimiter = Some(d);
            command_start = i + 1;
        } else if arg == "-n" && i + 1 < args.len() {
            i += 1;
            match args[i].parse::<usize>() {
                Ok(n) if n >= 1 => max_args = Some(n),
                _ => return fail(format!("xargs: invalid number for -n: '{}'\n", args[i]), 1),
            }
            command_start = i + 1;
        } else if arg == "-P" && i + 1 < args.len() {
            i += 1;
            command_start = i + 1;
        } else if arg == "-0" || arg == "--null" {
            null_separator = true;
            command_start = i + 1;
        } else if arg == "-t" || arg == "--verbose" {
            verbose = true;
            command_start = i + 1;
        } else if arg == "-r" || arg == "--no-run-if-empty" {
            no_run_if_empty = true;
            command_start = i + 1;
        } else if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
            for c in arg[1..].chars() {
                match c {
                    '0' => null_separator = true,
                    't' => verbose = true,
                    'r' => no_run_if_empty = true,
                    _ => return fail(format!("xargs: unrecognized option '-{c}'\n"), 1),
                }
            }
            command_start = i + 1;
        } else if !arg.starts_with('-') {
            command_start = i;
            break;
        }
        i += 1;
    }

    let mut command: Vec<String> = args[command_start..].to_vec();
    if command.is_empty() {
        command.push("echo".to_string());
    }

    let items: Vec<String> = if null_separator {
        split_exact(&stdin, "\0")
    } else if let Some(d) = &delimiter {
        if d.is_empty() {
            return fail("xargs: delimiter must not be empty\n".to_string(), 1);
        }
        let input = stdin.strip_suffix('\n').unwrap_or(&stdin);
        split_exact(input, d)
    } else {
        split_whitespace_items(&stdin)
    };

    if items.is_empty() {
        if no_run_if_empty {
            return ok(String::new());
        }
        return ok(String::new());
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = 0;

    let quote_arg = |arg: &str| -> String {
        if arg
            .chars()
            .any(|c| " \t\n\"'\\$`!*?[]{}();&|<>#".contains(c))
        {
            let mut escaped = String::new();
            for c in arg.chars() {
                if "\\\"$`".contains(c) {
                    escaped.push('\\');
                }
                escaped.push(c);
            }
            format!("\"{escaped}\"")
        } else {
            arg.to_string()
        }
    };

    let run_one = |interp: &mut Interpreter,
                   cmd_args: Vec<String>,
                   stdout: &mut String,
                   stderr: &mut String,
                   exit_code: &mut i32| {
        if verbose {
            let line: Vec<String> = cmd_args.iter().map(|a| quote_arg(a)).collect();
            stderr.push_str(&line.join(" "));
            stderr.push('\n');
        }
        let out = super::dispatch(interp, &cmd_args, String::new(), None);
        stdout.push_str(&out.stdout);
        stderr.push_str(&out.stderr);
        if out.exit_code != 0 {
            *exit_code = out.exit_code;
        }
    };

    if let Some(replace) = &replace_str {
        if replace.is_empty() {
            return fail(
                "xargs: replacement string must not be empty\n".to_string(),
                1,
            );
        }
        for item in &items {
            let cmd_args: Vec<String> = command
                .iter()
                .map(|c| c.replace(replace.as_str(), item))
                .collect();
            run_one(interp, cmd_args, &mut stdout, &mut stderr, &mut exit_code);
        }
    } else if let Some(n) = max_args {
        for chunk in items.chunks(n) {
            let mut cmd_args = command.clone();
            cmd_args.extend(chunk.iter().cloned());
            run_one(interp, cmd_args, &mut stdout, &mut stderr, &mut exit_code);
        }
    } else {
        let mut cmd_args = command.clone();
        cmd_args.extend(items.iter().cloned());
        run_one(interp, cmd_args, &mut stdout, &mut stderr, &mut exit_code);
    }

    CommandOutput {
        stdout,
        stderr,
        exit_code,
    }
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
    fn default_echo_joins_args() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf 'a\\nb\\nc\\n' | xargs echo");
        assert_eq!(r.stdout, "a b c\n");
    }

    #[test]
    fn dash_n_batches() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf 'a\\nb\\nc\\nd\\n' | xargs -n 2 echo");
        assert_eq!(r.stdout, "a b\nc d\n");
    }

    #[test]
    fn dash_i_replaces_placeholder() {
        let mut bash = fresh();
        let r = run(&mut bash, r#"printf 'a\nb\n' | xargs -I {} echo "[{}]""#);
        assert_eq!(r.stdout, "[a]\n[b]\n");
    }

    #[test]
    fn no_command_defaults_to_echo() {
        let mut bash = fresh();
        let r = run(&mut bash, r#"echo hi | xargs"#);
        assert_eq!(r.stdout, "hi\n");
    }

    #[test]
    fn null_separated_input() {
        let mut bash = fresh();
        let r = run(&mut bash, r#"printf "a\0b\0" | xargs -0 echo"#);
        assert_eq!(r.stdout, "a b\n");
    }
}
